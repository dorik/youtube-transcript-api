import { execFile } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import axios from "axios";
import { config } from "../config/env";
import { proxyAxiosOptions } from "../config/proxy";
import { logger } from "../config/logger";
import {
  NoTranscriptError,
  UpstreamBlockedError,
  VideoNotFoundError,
} from "../utils/errors";
import { Segment } from "./formatters";
import { normalizeLanguageCode } from "../utils/languageCodes";

const execFileAsync = promisify(execFile);

/**
 * Defensive concurrency cap for yt-dlp subprocesses on this path.
 *
 * Each yt-dlp run uses ~50–100 MB of RAM while it parses the watch page.
 * The Render free instance has 512 MB total, so an unguarded burst (e.g. a
 * batch caller hitting us with 20 videos at once) would OOM-kill the
 * process. Three concurrent extractions is comfortably within budget and
 * still fully serializes per-user requests on a single CPU. Bump on a
 * larger plan.
 */
const MAX_CONCURRENT_YTDLP = 3;

export interface YouTubeFetchResult {
  videoId: string;
  segments: Segment[];
  language: string;
  durationSeconds: number;
  source: "native_captions";
}

export interface YouTubeMetadata {
  videoId: string;
  title: string | null;
  channel: string | null;
  thumbnailUrl: string | null;
}

// ── yt-dlp output shapes ────────────────────────────────────────────────────
// yt-dlp's `--dump-single-json` emits everything it knows about the video.
// We only need the caption catalogs and the duration; the rest of the dump
// is discarded.

interface YtDlpCaptionTrack {
  ext: string;
  url: string;
  name?: string;
}

interface YtDlpDump {
  id: string;
  duration?: number;
  /** Manually authored caption tracks, keyed by language tag. */
  subtitles?: Record<string, YtDlpCaptionTrack[]>;
  /**
   * Auto-generated tracks (Whisper-on-YouTube). Includes both the original
   * recognised language (e.g. `en`, `en-orig`) AND auto-translated variants
   * the YouTube UI offers (`en-fr`, `en-de`, ...). We deliberately skip the
   * machine-translated variants — they're noisy and the user is better
   * served by the genuine source-language track.
   */
  automatic_captions?: Record<string, YtDlpCaptionTrack[]>;
}

/** YouTube's `json3` timed-text format. */
interface Json3Caption {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    /** Text fragments that get concatenated into the final caption text. */
    segs?: Array<{ utf8?: string }>;
  }>;
}

/**
 * Fetch native YouTube captions for a video.
 *
 * Backed by yt-dlp instead of the unmaintained `youtube-transcript` npm
 * package — yt-dlp is patched within hours of YouTube frontend changes
 * and has first-class proxy support, which matters on shared datacenter
 * IPs (Render, etc.) where YouTube is increasingly aggressive about
 * bot challenges.
 *
 * Strategy: ask yt-dlp for the dump JSON (one HTTPS round-trip to the
 * watch page), pick the best-matching caption track from its catalogs,
 * then fetch that track directly as `json3`. No subtitle file is written
 * to disk — we keep the whole flow in-memory.
 *
 * - When `language` is undefined or 'auto', any available track is
 *   acceptable; manual tracks beat auto-generated ones.
 * - When a specific language is requested but not available, we fall back
 *   to whatever genuine track exists (parity with the previous library's
 *   behaviour). Users prefer "wrong language" over "no transcript".
 *
 * Throws:
 * - `NoTranscriptError` — captions are disabled or unavailable. Caller may
 *   fall back to Whisper.
 * - `VideoNotFoundError` — video does not exist / is private / was removed.
 * - `UpstreamBlockedError` — YouTube is throttling us (HTTP 429) or serving
 *   the "Sign in to confirm you're not a bot" challenge. Falling back to
 *   Whisper won't help — both yt-dlp paths share the same egress IP, so the
 *   audio download will hit the same wall. Operator needs to set PROXY_URL
 *   or YT_COOKIES_PATH.
 */
export async function fetchYouTubeCaptions(
  videoId: string,
  language?: string,
): Promise<YouTubeFetchResult> {
  const requestedLang =
    language && language !== "auto" && language.trim() ? language : undefined;

  return runWithLimit(async () => {
    const dump = await dumpVideoInfo(videoId);
    const pick = pickCaptionTrack(dump, requestedLang);
    if (!pick) {
      throw new NoTranscriptError(videoId);
    }

    const segments = await fetchAndParseJson3(pick.url, videoId);
    if (!segments.length) {
      // yt-dlp gave us a caption URL but the body was empty / unparseable.
      // Treat as if no transcript exists so the caller can fall back.
      throw new NoTranscriptError(videoId);
    }

    // Prefer the duration yt-dlp reported (precise, taken from the player
    // config). Fall back to inferring from the last segment when the dump
    // omits it (rare; happens for ongoing live streams).
    const last = segments[segments.length - 1];
    const durationSeconds =
      typeof dump.duration === "number" && dump.duration > 0
        ? Math.ceil(dump.duration)
        : Math.ceil(last.start + last.duration);

    if (requestedLang && pick.lang !== requestedLang) {
      logger.info(
        {
          videoId,
          requested: requestedLang,
          served: pick.lang,
          source: pick.source,
        },
        "Requested caption language unavailable; served best alternative track",
      );
    }

    return {
      videoId,
      segments,
      // Normalize at the boundary: `pick.lang` can be `en-orig`, `en-auto`,
      // or a mis-cased region tag, none of which would strict-match against
      // an ISO code from the request layer. Downstream code compares this
      // against `translate_to`, the user's `language`, and cache keys —
      // all expected to be canonical ISO 639-1.
      language: normalizeLanguageCode(pick.lang) || pick.lang,
      durationSeconds,
      source: "native_captions",
    };
  });
}

/**
 * Run yt-dlp with `--dump-single-json` to extract the watch-page metadata
 * (including subtitle URLs). No video bytes are downloaded; this is just a
 * single GET to the watch page plus YouTube player-config decoding inside
 * yt-dlp. Typical wall time: 0.5–2s on a warm process.
 */
async function dumpVideoInfo(videoId: string): Promise<YtDlpDump> {
  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    "--skip-download",
    "--dump-single-json",
    "--no-warnings",
    // Defensive: a stray `&list=` in the URL would otherwise trigger a
    // playlist walk we don't want.
    "--no-playlist",
    // This call only reads caption catalogs + duration — it never needs a
    // media format. yt-dlp still resolves a format for the JSON by default
    // and aborts the whole dump with "Requested format is not available"
    // when YouTube serves a session/IP a degraded player response with no
    // usable formats (intermittent). Tolerating that keeps captions working.
    "--ignore-no-formats-error",
    ...ytDlpNetworkArgs(),
  ];

  let stdout: string;
  try {
    const result = await execFileAsync("yt-dlp", args, {
      timeout: 30_000,
      // The dump can be large for popular videos (hundreds of auto-translated
      // caption entries, full chapter list, etc.). 50 MB is plenty.
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    throw mapYtDlpError(err, videoId);
  }

  try {
    return JSON.parse(stdout) as YtDlpDump;
  } catch (err) {
    logger.error({ err, videoId }, "yt-dlp dump produced unparseable JSON");
    throw new NoTranscriptError(videoId);
  }
}

interface PickedTrack {
  lang: string;
  url: string;
  source: "manual" | "auto";
}

/**
 * Choose the best caption track from yt-dlp's catalogs.
 *
 * Order of preference:
 *  1. Requested language, manual track (best quality, human-authored).
 *  2. Requested language, auto-generated track.
 *  3. Any genuine manual track (matches old library behaviour: a user asking
 *     for `en` on a Bangla-only video gets Bangla rather than nothing).
 *  4. Any genuine auto-generated track.
 *
 * Machine-translated variants are stripped from both catalogs up front (see
 * `stripTranslatedTracks`), so none of the steps above can select one —
 * they're a low-quality MT cascade and YouTube rate-limits the endpoint that
 * serves them (HTTP 429).
 */
export function pickCaptionTrack(
  dump: YtDlpDump,
  requestedLang: string | undefined,
): PickedTrack | null {
  const manual = stripTranslatedTracks(dump.subtitles ?? {});
  const auto = stripTranslatedTracks(dump.automatic_captions ?? {});

  return (
    pickByLang(manual, requestedLang, "manual") ??
    pickByLang(auto, requestedLang, "auto") ??
    pickAny(manual, "manual") ??
    pickAny(auto, "auto")
  );
}

function pickByLang(
  catalog: Record<string, YtDlpCaptionTrack[]>,
  lang: string | undefined,
  source: "manual" | "auto",
): PickedTrack | null {
  if (!lang) return null;
  const keys = Object.keys(catalog);

  // Exact match wins (e.g. requested `en`, catalog has `en`).
  const exact = keys.find((k) => k === lang);
  if (exact) {
    const url = trackUrl(catalog[exact]);
    if (url) return { lang: exact, url, source };
  }

  // Then a region-stripped match (e.g. requested `en`, catalog has `en-US`,
  // or vice versa). Translated tracks were already removed by the caller.
  const requestedBase = lang.split(/[-_]/)[0];
  const prefix = keys.find((k) => k.split(/[-_]/)[0] === requestedBase);
  if (prefix) {
    const url = trackUrl(catalog[prefix]);
    if (url) return { lang: prefix, url, source };
  }

  return null;
}

function pickAny(
  catalog: Record<string, YtDlpCaptionTrack[]>,
  source: "manual" | "auto",
): PickedTrack | null {
  for (const [lang, tracks] of Object.entries(catalog)) {
    const url = trackUrl(tracks);
    if (url) return { lang, url, source };
  }
  return null;
}

/**
 * Drop machine-translated caption tracks from a yt-dlp catalog.
 *
 * `automatic_captions` lists, for every video, ~150 auto-TRANSLATED variants
 * (YouTube will translate any caption into any UI language) alongside the
 * genuine source-language track(s). We never want a translated one: the
 * content is a low-quality MT cascade, and — critically — YouTube rate-limits
 * the timed-text *translation* endpoint hard, returning HTTP 429 where the
 * plain caption fetch returns 200.
 *
 * The reliable, yt-dlp-version-proof signal is the track URL: a genuine track
 * carries only `lang=`; a translated one additionally carries `tlang=`. We do
 * NOT key off the catalog *key* — yt-dlp names translation entries with bare
 * target codes (`ab`, `aa`, `af`, ...), indistinguishable by name from a
 * genuine track's key (which is why the previous `xx-yy` regex never matched
 * them, and every `auto` request silently fetched the Abkhazian translation).
 */
function stripTranslatedTracks(
  catalog: Record<string, YtDlpCaptionTrack[]>,
): Record<string, YtDlpCaptionTrack[]> {
  const out: Record<string, YtDlpCaptionTrack[]> = {};
  for (const [lang, tracks] of Object.entries(catalog)) {
    const genuine = (tracks ?? []).filter((t) => !isTranslatedTrackUrl(t.url));
    if (genuine.length) out[lang] = genuine;
  }
  return out;
}

/** True when a timed-text URL requests an on-the-fly translation (`tlang=`). */
function isTranslatedTrackUrl(url: string): boolean {
  return /[?&]tlang=/.test(url);
}

/**
 * Pick the json3 variant of a track when present. yt-dlp lists tracks in
 * multiple formats (json3, srv1, srv2, srv3, ttml, vtt). json3 is the
 * canonical YouTube format and the easiest to parse; everything else falls
 * back to URL-rewriting in `fetchAndParseJson3`.
 */
function trackUrl(tracks: YtDlpCaptionTrack[] | undefined): string | null {
  if (!tracks?.length) return null;
  const json3 = tracks.find((t) => t.ext === "json3");
  return (json3 ?? tracks[0]).url;
}

/**
 * Fetch a single caption track directly from YouTube's timed-text endpoint
 * and parse the json3 response into our internal `Segment` shape.
 *
 * The URL yt-dlp embeds in its dump already carries the short-lived signing
 * parameters required by YouTube's timed-text service, so this is a plain
 * HTTPS GET — no further auth or extraction needed.
 */
async function fetchAndParseJson3(
  url: string,
  videoId: string,
): Promise<Segment[]> {
  // If the URL was for a non-json3 format, force json3 — the timed-text
  // endpoint accepts `&fmt=json3` for any track, regardless of the format
  // yt-dlp originally listed it under.
  const u = new URL(url);
  if (u.searchParams.get("fmt") !== "json3") u.searchParams.set("fmt", "json3");

  let body: Json3Caption;
  try {
    const { data } = await axios.get<Json3Caption>(u.toString(), {
      timeout: 12_000,
      // YouTube serves json3 as text/plain occasionally; force the JSON
      // parser so we don't end up with a string.
      responseType: "json",
      transformResponse: (raw: unknown) => {
        if (typeof raw !== "string") return raw;
        try {
          return JSON.parse(raw);
        } catch {
          return {};
        }
      },
      // Route through PROXY_URL when set — Render's datacenter egress
      // gets 429'd on this endpoint within minutes of traffic.
      ...proxyAxiosOptions(),
    });
    body = data ?? {};
  } catch (err) {
    logger.warn({ err, videoId }, "Caption track fetch failed");
    // The track URL came straight from yt-dlp's dump, so a failed GET here
    // is an upstream/network problem — very often a 429 on a datacenter IP
    // (see the proxy note above) — NOT evidence the video lacks captions.
    // Throwing NoTranscriptError here used to mislabel a transient block as
    // a permanent "no captions" result, which both suppressed a meaningful
    // error and short-circuited straight past the Whisper fallback's own
    // (equally blocked) failure. A genuinely empty caption body is caught
    // by the `!segments.length` check in fetchYouTubeCaptions instead.
    throw new UpstreamBlockedError(60);
  }

  const events = body.events ?? [];
  const segments: Segment[] = [];
  for (const event of events) {
    const text = (event.segs ?? [])
      .map((s) => s.utf8 ?? "")
      .join("")
      // json3 caption events sometimes contain literal newlines as line
      // breaks within a single phrase. Collapse them so downstream
      // formatters don't accidentally insert paragraph breaks mid-segment.
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    segments.push({
      start: (event.tStartMs ?? 0) / 1000,
      // dDurationMs is occasionally missing on the very last event for live
      // streams. A non-zero duration keeps SRT/VTT renderers happy.
      duration: Math.max(0.001, (event.dDurationMs ?? 0) / 1000),
      text,
    });
  }
  return segments;
}

/**
 * Build the proxy/cookie args shared by every yt-dlp invocation in this app.
 *
 * Kept as a function (not a constant) because `config` is loaded once at
 * boot — using a function lets us defensively re-read on each call without
 * tying tests to module-import order.
 */
/**
 * Resolve a *writable* cookie file path for yt-dlp.
 *
 * yt-dlp rewrites its `--cookies` file on exit to persist rotated session
 * cookies. Render mounts Secret Files read-only (`/etc/secrets/...`), so
 * handing yt-dlp that path directly crashes it with
 * `OSError: [Errno 30] Read-only file system` *after* an otherwise
 * successful fetch. We sidestep that by copying the configured file once to
 * a writable temp path and giving yt-dlp the copy — it is then free to
 * rewrite it, and the rotated cookies survive for the process lifetime.
 *
 * Returns the writable path, or null when cookies are not configured, the
 * source file is missing, or the copy failed.
 */
function resolveWritableCookiesPath(): string | null {
  const source = config.YT_COOKIES_PATH;
  if (!source || !existsSync(source)) {
    return null;
  }
  const dest = join(tmpdir(), "yt-dlp-cookies.txt");
  // Copy only on first use: a later call must not clobber the cookies
  // yt-dlp rotated into `dest`.
  if (existsSync(dest)) {
    return dest;
  }
  try {
    copyFileSync(source, dest);
    return dest;
  } catch (err) {
    logger.warn(
      { err, source },
      "Failed to copy cookie file to a writable path; proceeding without cookies",
    );
    return null;
  }
}

export function ytDlpNetworkArgs(): string[] {
  const args: string[] = [];
  if (config.PROXY_URL) {
    args.push("--proxy", config.PROXY_URL);
  }

  const cookiesPath = resolveWritableCookiesPath();
  if (cookiesPath) {
    // The only knob YouTube currently respects for "Sign in to confirm
    // you're not a bot" without an IP rotation. Must be the writable copy —
    // see resolveWritableCookiesPath.
    args.push("--cookies", cookiesPath);
  }

  // Surface the anti-bot configuration on every yt-dlp call. A YT_COOKIES_PATH
  // that points at a missing or unreadable file is silently useless — yt-dlp
  // just proceeds unauthenticated — so we report whether a usable cookie file
  // was actually resolved, and warn loudly when it was configured but is not.
  const configured = Boolean(config.YT_COOKIES_PATH);
  const networkConfig = {
    cookiesConfigured: configured,
    cookiesSourcePath: config.YT_COOKIES_PATH ?? null,
    cookiesActivePath: cookiesPath,
    cookiesFileBytes: cookiesPath ? statSync(cookiesPath).size : 0,
    proxyConfigured: Boolean(config.PROXY_URL),
  };
  if (configured && !cookiesPath) {
    logger.warn(
      networkConfig,
      "yt-dlp: YT_COOKIES_PATH set but no usable cookie file",
    );
  } else {
    logger.info(networkConfig, "yt-dlp network config");
  }

  return args;
}

/**
 * Translate a yt-dlp subprocess failure into one of our domain errors.
 *
 * yt-dlp doesn't expose structured exit codes for these conditions — we have
 * to grep its stderr. The patterns below are stable across recent yt-dlp
 * releases; if YouTube changes the wording, new branches go here.
 *
 * `context` is used only for the fallback log line — pass 'captions' or
 * 'whisper-audio' so triage can tell which yt-dlp path failed.
 */
export function mapYtDlpError(
  err: unknown,
  videoId: string,
  context: "captions" | "whisper-audio" = "captions",
): Error {
  const stderr =
    isExecError(err) && typeof err.stderr === "string" ? err.stderr : "";
  const message = err instanceof Error ? err.message : String(err);
  const blob = `${stderr}\n${message}`.toLowerCase();

  // Diagnostic: every yt-dlp failure (caption path + whisper-audio path)
  // passes through here. The raw stderr is what YouTube literally
  // returned, so this is the ground truth for "is YouTube blocking us
  // or is our code misbehaving". Search Render logs for "yt-dlp failed" to
  // pull these lines. `args` is intentionally NOT logged — when
  // PROXY_URL is set it contains proxy credentials in plaintext.
  logger.warn(
    {
      videoId,
      context,
      blob,
      proxyConfigured: Boolean(config.PROXY_URL),
      cookiesConfigured: Boolean(config.YT_COOKIES_PATH),
      exitCode: isExecError(err) ? err.code : undefined,
      stderr: stderr.slice(0, 1500),
      messageHead: message.slice(0, 300),
    },
    "error: yt-dlp failed",
  );

  if (
    blob.includes("video unavailable") ||
    blob.includes("private video") ||
    blob.includes("removed by the uploader") ||
    blob.includes("this video is not available") ||
    blob.includes("does not exist")
  ) {
    return new VideoNotFoundError(videoId);
  }
  if (
    blob.includes("http error 429") ||
    blob.includes("too many requests") ||
    // YouTube's anti-bot challenge — different wording across yt-dlp versions
    // and YouTube locales. Both straight and curly apostrophes appear.
    blob.includes("sign in to confirm you're not a bot") ||
    blob.includes("sign in to confirm you’re not a bot") ||
    blob.includes("sign in to confirm your age")
  ) {
    return new UpstreamBlockedError(60);
  }

  // Unrecognized yt-dlp failure. This is NOT evidence the video lacks
  // captions: a genuine "captions disabled" video produces a *successful*
  // dump with empty catalogs, handled in fetchYouTubeCaptions and never
  // routed through here. Reaching this branch means the yt-dlp subprocess
  // itself failed — a network blip, a bot-challenge whose wording YouTube
  // changed, or a yt-dlp version drift. Defaulting to NoTranscriptError
  // turned every such failure into a permanent, non-retryable "no captions"
  // result and made the Whisper fallback look broken. Treat it as a
  // transient upstream error so the worker retries and the caller gets an
  // honest 503 instead of a misleading NO_TRANSCRIPT.
  logger.warn(
    { err, videoId, context, stderr: stderr.slice(0, 500) },
    "yt-dlp call failed with an unrecognized error; treating as upstream-blocked",
  );
  return new UpstreamBlockedError(60);
}

function isExecError(
  err: unknown,
): err is { stderr?: string; stdout?: string; code?: number | string } {
  return (
    typeof err === "object" &&
    err !== null &&
    ("stderr" in err || "code" in err)
  );
}

// ── Concurrency limiter ─────────────────────────────────────────────────────
// Tiny FIFO semaphore. Avoids a `p-limit` dependency for ~10 lines of code.
// All in-flight fetches share this single counter — the limiter is module-
// scoped, not per-call.

let activeYtDlp = 0;
const ytDlpQueue: Array<() => void> = [];

async function runWithLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (activeYtDlp >= MAX_CONCURRENT_YTDLP) {
    await new Promise<void>((resolve) => ytDlpQueue.push(resolve));
  }
  activeYtDlp += 1;
  try {
    return await fn();
  } finally {
    activeYtDlp -= 1;
    const next = ytDlpQueue.shift();
    if (next) next();
  }
}

// ── Metadata ────────────────────────────────────────────────────────────────

/**
 * Single oEmbed HTTP round-trip, shared by the lenient and strict metadata
 * helpers below. Returns the raw payload; it does NOT decide what a failure
 * means — that policy belongs to each caller.
 *
 * Kept as oEmbed (rather than rolled into the yt-dlp dump above) on purpose:
 * oEmbed is a first-party YouTube API, doesn't count against scraping
 * budgets, and is the cheapest path for metadata-only callers. It gives us
 * title + author + thumbnail but NOT duration.
 */
async function fetchOEmbedData(
  videoId: string,
): Promise<Record<string, unknown>> {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const { data } = await axios.get(url, {
    timeout: 8_000,
    ...proxyAxiosOptions(),
  });
  return (data ?? {}) as Record<string, unknown>;
}

function metadataFromOEmbed(
  videoId: string,
  data: Record<string, unknown>,
): YouTubeMetadata {
  return {
    videoId,
    // `null` (not 'Untitled') when oEmbed omits a field — a null is an
    // honest "unknown" the caller / SQL COALESCE can react to, whereas a
    // placeholder string would be persisted as if it were real data.
    title: typeof data.title === "string" ? data.title : null,
    channel: typeof data.author_name === "string" ? data.author_name : null,
    thumbnailUrl:
      typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
  };
}

/**
 * Fetch lightweight video metadata via oEmbed — best-effort.
 *
 * Every failure is swallowed into null fields. Correct for callers that use
 * this purely to decorate an already-successful result (the worker's row
 * prefetch, the post-transcript cache write): a missing title must never fail
 * a request that already did its real work. Callers that BILL on the metadata
 * itself must use `fetchYouTubeMetadataStrict` instead.
 */
export async function fetchYouTubeMetadata(
  videoId: string,
): Promise<YouTubeMetadata> {
  try {
    return metadataFromOEmbed(videoId, await fetchOEmbedData(videoId));
  } catch (err) {
    logger.warn(
      { err, videoId },
      "oEmbed metadata fetch failed; returning null metadata",
    );
    return { videoId, title: null, channel: null, thumbnailUrl: null };
  }
}

/**
 * Strict counterpart to `fetchYouTubeMetadata` for callers that bill the
 * request and therefore must NOT treat an empty result as success.
 *
 * A video that genuinely does not exist surfaces as `VideoNotFoundError`
 * (404); a fetch we simply could not complete surfaces as
 * `UpstreamBlockedError` (503). Neither path returns a placeholder the caller
 * would be charged for, and the returned `title` is always a real string.
 *
 * oEmbed answers 404/401 for a video that is missing/removed/private, and
 * 429/5xx (or a network error) when YouTube is throttling us.
 */
export async function fetchYouTubeMetadataStrict(
  videoId: string,
): Promise<YouTubeMetadata & { title: string }> {
  let data: Record<string, unknown>;
  try {
    data = await fetchOEmbedData(videoId);
  } catch (err) {
    // A definitive "this video is not accessible" answer from oEmbed.
    if (
      axios.isAxiosError(err) &&
      [400, 401, 404].includes(err.response?.status ?? 0)
    ) {
      throw new VideoNotFoundError(videoId);
    }
    // 429 / 5xx / network — we could not determine anything. Upstream.
    logger.warn({ err, videoId }, "oEmbed (strict) metadata fetch failed");
    throw new UpstreamBlockedError(60);
  }

  // oEmbed responded 200 but without a usable title — treat as not found
  // rather than billing the caller for an empty result.
  if (typeof data.title !== "string" || !data.title.trim()) {
    throw new VideoNotFoundError(videoId);
  }

  return { ...metadataFromOEmbed(videoId, data), title: data.title };
}
