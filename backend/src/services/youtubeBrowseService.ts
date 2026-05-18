import axios from 'axios';
import { isProxyConfigured, proxyAxiosOptions } from '../config/proxy';
import { logger } from '../config/logger';
import { buildWatchUrl, extractVideoId } from '../utils/youtubeUrl';
import { UpstreamBlockedError, ValidationError } from '../utils/errors';
import { fetchYouTubeMetadataStrict } from './youtubeService';

export type SearchType = 'video' | 'channel' | 'playlist' | 'all';

export interface BrowseVideo {
  video_id: string;
  url: string;
  title: string;
  channel: string | null;
  channel_id: string | null;
  duration_text: string | null;
  published_text: string | null;
  view_count_text: string | null;
  thumbnail_url: string | null;
}

export interface BrowseChannel {
  channel_id: string;
  url: string;
  title: string;
  handle: string | null;
  subscriber_count_text: string | null;
  thumbnail_url: string | null;
}

export interface BrowsePlaylist {
  playlist_id: string;
  url: string;
  title: string;
  channel: string | null;
  video_count_text: string | null;
  thumbnail_url: string | null;
}

export interface SearchResponse {
  query: string;
  type: SearchType;
  items: Array<BrowseVideo | BrowseChannel | BrowsePlaylist>;
}

export interface VideosResponse {
  channel: string;
  items: BrowseVideo[];
}

export interface PlaylistVideosResponse {
  playlist_id: string;
  items: BrowseVideo[];
}

export interface VideoMetadataResponse {
  video_id: string;
  url: string;
  title: string;
  channel: string;
  description: string | null;
  duration_seconds: number | null;
  view_count: number | null;
  thumbnail_url: string | null;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function searchYouTube(input: {
  query: string;
  type: SearchType;
  limit: number;
}): Promise<SearchResponse> {
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', input.query);
  const initialData = await fetchInitialData(url.toString());

  const videos = mapValid(collectVideoRenderers(initialData), videoFromRenderer);
  const channels = mapValid(collectChannelRenderers(initialData), channelFromRenderer);
  const playlists = mapValid(collectPlaylistRenderers(initialData), playlistFromRenderer);

  const items =
    input.type === 'video'
      ? videos
      : input.type === 'channel'
        ? channels
        : input.type === 'playlist'
          ? playlists
          : [...videos, ...channels, ...playlists];

  return {
    query: input.query,
    type: input.type,
    items: dedupeByUrl(items).slice(0, input.limit),
  };
}

export async function listChannelVideos(input: {
  channel: string;
  query?: string;
  limit: number;
}): Promise<VideosResponse> {
  const base = normalizeChannelUrl(input.channel);
  const url = input.query
    ? `${base}/search?query=${encodeURIComponent(input.query)}`
    : `${base}/videos`;
  const initialData = await fetchInitialData(url);
  // Modern channel /videos pages render their grid as lockupViewModel
  // (LOCKUP_CONTENT_TYPE_VIDEO), not the legacy videoRenderer. Collect both
  // — legacy first because its mapper is richer (channel name, channel id)
  // — then merge and dedupe by video_id. Without the lockup pass we get
  // zero results for any channel whose grid has rolled out to the new
  // layout, even though videos are clearly present.
  const items = dedupeVideos([
    ...mapValid(collectVideoRenderers(initialData), videoFromRenderer),
    ...mapValid(collectLockupVideoViewModels(initialData), videoFromLockup),
  ]);
  // The lockupViewModel layout (now the default on most channel pages) carries
  // no per-row channel name/id, so videoFromLockup leaves both null. The
  // channel page itself knows them — backfill from its channelMetadataRenderer
  // header so every item is enriched consistently regardless of which grid
  // layout YouTube served (bug L4).
  const identity = extractChannelIdentity(initialData);
  const enriched = items.map((item) => ({
    ...item,
    channel: item.channel ?? identity.name,
    channel_id: item.channel_id ?? identity.id,
  }));
  return {
    channel: input.channel,
    items: enriched.slice(0, input.limit),
  };
}

/**
 * Read a channel page's own identity (display name + UC… id) from its
 * `channelMetadataRenderer` header. Used to backfill per-row channel info on
 * layouts (lockupViewModel) that omit it.
 */
function extractChannelIdentity(root: unknown): {
  name: string | null;
  id: string | null;
} {
  const meta = collectObjects(root, 'channelMetadataRenderer')[0];
  if (!meta) return { name: null, id: null };
  return {
    name: typeof meta.title === 'string' ? meta.title : null,
    id: typeof meta.externalId === 'string' ? meta.externalId : null,
  };
}

export async function listPlaylistVideos(input: {
  playlist: string;
  limit: number;
}): Promise<PlaylistVideosResponse> {
  const playlistId = extractPlaylistId(input.playlist);
	const initialData = await fetchInitialData(
		`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
	);
	const items = dedupeVideos([
		...mapValid(collectPlaylistVideoRenderers(initialData), videoFromRenderer),
		...mapValid(collectVideoRenderers(initialData), videoFromRenderer),
	]);
	if (items.length === 0) {
		throw new ValidationError(
			'No playlist videos found. If this playlist is private, make it public or unlisted before using the API.',
		);
	}
	return {
		playlist_id: playlistId,
		items: items.slice(0, input.limit),
  };
}

export async function getVideoMetadata(input: string): Promise<VideoMetadataResponse> {
  const videoId = extractVideoId(input);
  try {
    const player = await fetchPlayerResponse(videoId);
    const details = isRecord(player.videoDetails) ? player.videoDetails : {};
    // Only treat the player scrape as a hit when it actually carried a title.
    // A removed / private / nonexistent video still returns a player page,
    // but with no usable videoDetails — fall through to the oEmbed probe so
    // we return an honest 404 instead of a charged "Untitled/Unknown" row.
    if (typeof details.title === 'string' && details.title.trim()) {
      return {
        video_id: videoId,
        url: buildWatchUrl(videoId),
        title: details.title,
        channel: typeof details.author === 'string' ? details.author : 'Unknown',
        description:
          typeof details.shortDescription === 'string' ? details.shortDescription : null,
        duration_seconds:
          typeof details.lengthSeconds === 'string' ? Number(details.lengthSeconds) : null,
        view_count: typeof details.viewCount === 'string' ? Number(details.viewCount) : null,
        thumbnail_url: thumbnailFromPlayer(details),
      };
    }
    logger.warn({ videoId }, 'Player response carried no videoDetails; falling back to oEmbed');
  } catch (err) {
    logger.warn({ err, videoId }, 'Player metadata fetch failed; falling back to oEmbed');
  }

  // Strict oEmbed probe: throws VideoNotFoundError (404) for a video that
  // does not exist and UpstreamBlockedError (503) when the fetch itself
  // failed. It never yields a placeholder — so the route's chargeBrowseCredit
  // call, which runs only on a successful return, can't bill an empty result.
  const metadata = await fetchYouTubeMetadataStrict(videoId);
  return {
    video_id: videoId,
    url: buildWatchUrl(videoId),
    // fetchYouTubeMetadataStrict guarantees a real title (it throws otherwise).
    title: metadata.title,
    channel: metadata.channel ?? 'Unknown',
    description: null,
    duration_seconds: null,
    view_count: null,
    thumbnail_url: metadata.thumbnailUrl,
  };
}

async function fetchInitialData(url: string): Promise<unknown> {
  try {
    const { data } = await axios.get<string>(url, {
      timeout: 12_000,
      responseType: 'text',
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
      },
      ...proxyAxiosOptions(),
    });
    return extractInitialData(data);
  } catch (err) {
    logger.warn({ err, url, proxyConfigured: isProxyConfigured() }, 'YouTube browse fetch failed');
    // Any failure here — an axios error (429 / network), a YouTube consent or
    // bot-challenge page that carries no `ytInitialData` marker, or page
    // JSON we could not parse — means we could not get usable data from
    // YouTube. The caller's input was already schema-validated at the route,
    // so this is always an upstream problem, never the client's fault.
    // Surface a transient 503 UPSTREAM_BLOCKED instead of letting a raw
    // axios error or SyntaxError escape as an opaque 500 INTERNAL_ERROR.
    if (err instanceof UpstreamBlockedError) throw err;
    throw new UpstreamBlockedError(60);
  }
}

function extractInitialData(html: string): unknown {
  const marker = 'var ytInitialData = ';
  const start = html.indexOf(marker);
  if (start === -1) {
    throw new ValidationError('Could not read YouTube page data');
  }
  const jsonStart = start + marker.length;
  const jsonEnd = findJsonEnd(html, jsonStart);
  if (jsonEnd === -1) {
    throw new ValidationError('Could not parse YouTube page data');
  }
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

async function fetchPlayerResponse(videoId: string): Promise<Record<string, unknown>> {
  const { data } = await axios.get<string>(buildWatchUrl(videoId), {
    timeout: 12_000,
    responseType: 'text',
    headers: {
      'user-agent': USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
    },
    ...proxyAxiosOptions(),
  });
  const marker = 'var ytInitialPlayerResponse = ';
  const start = data.indexOf(marker);
  if (start === -1) {
    throw new ValidationError('Could not read YouTube player metadata');
  }
  const jsonStart = start + marker.length;
  const jsonEnd = findJsonEnd(data, jsonStart);
  if (jsonEnd === -1) {
    throw new ValidationError('Could not parse YouTube player metadata');
  }
  const parsed = JSON.parse(data.slice(jsonStart, jsonEnd));
  if (!isRecord(parsed)) throw new ValidationError('Invalid YouTube player metadata');
  return parsed;
}

function findJsonEnd(input: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function collectVideoRenderers(root: unknown): Record<string, unknown>[] {
	return collectObjects(root, 'videoRenderer');
}

function collectPlaylistVideoRenderers(root: unknown): Record<string, unknown>[] {
	return collectObjects(root, 'playlistVideoRenderer');
}

function collectChannelRenderers(root: unknown): Record<string, unknown>[] {
	return collectObjects(root, 'channelRenderer');
}

function collectPlaylistRenderers(root: unknown): Record<string, unknown>[] {
  return collectObjects(root, 'playlistRenderer');
}

/**
 * Collect lockupViewModel nodes that are videos (not playlists or channels).
 * lockupViewModel is YouTube's newer flat shape that's replacing
 * videoRenderer on channel pages, watch sidebars, and elsewhere. The
 * `contentType` field tells us what the lockup wraps.
 */
function collectLockupVideoViewModels(root: unknown): Record<string, unknown>[] {
  return collectObjects(root, 'lockupViewModel').filter(
    (node) => node.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO',
  );
}

function collectObjects(root: unknown, key: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  walk(root, (node) => {
    const child = node[key];
    if (isRecord(child)) out.push(child);
  });
  return out;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function videoFromRenderer(renderer: Record<string, unknown>): BrowseVideo {
  const videoId = stringProp(renderer, 'videoId');
  return {
    video_id: videoId,
    url: buildWatchUrl(videoId),
    title: textProp(renderer, 'title') || 'Untitled',
    channel: bylineText(renderer),
    channel_id: channelId(renderer),
    duration_text: textProp(renderer, 'lengthText'),
    published_text: textProp(renderer, 'publishedTimeText'),
    view_count_text: textProp(renderer, 'viewCountText'),
    thumbnail_url: thumbnailUrl(renderer),
  };
}

/**
 * Map a lockupViewModel (new YouTube layout) to BrowseVideo.
 *
 * Channel name + id are NOT in this shape — the surrounding context is a
 * channel page where the caller already knows the channel. Callers that
 * need channel info on each row should attach it from the channel-page
 * header rather than the per-item lockup.
 */
function videoFromLockup(lockup: Record<string, unknown>): BrowseVideo {
  const videoId = stringProp(lockup, 'contentId');

  // metadata.lockupMetadataViewModel.{title.content, metadata.contentMetadataViewModel.metadataRows[].metadataParts[].text.content}
  const meta = isRecord(lockup.metadata)
    ? (lockup.metadata.lockupMetadataViewModel as Record<string, unknown> | undefined)
    : undefined;
  const titleNode = isRecord(meta?.title) ? meta!.title : undefined;
  const title =
    isRecord(titleNode) && typeof titleNode.content === 'string'
      ? (titleNode.content as string)
      : 'Untitled';

  // YouTube convention: first metadata row's parts are [views, publishedTime].
  // Both can be absent on premieres / live; default to null in that case.
  let viewCountText: string | null = null;
  let publishedText: string | null = null;
  const cmv = isRecord(meta?.metadata)
    ? (meta!.metadata.contentMetadataViewModel as Record<string, unknown> | undefined)
    : undefined;
  const rows = Array.isArray(cmv?.metadataRows) ? cmv!.metadataRows : [];
  for (const row of rows) {
    const parts = Array.isArray((row as Record<string, unknown>).metadataParts)
      ? ((row as Record<string, unknown>).metadataParts as unknown[])
      : [];
    if (parts.length >= 1 && viewCountText === null) {
      const t = (parts[0] as Record<string, unknown>)?.text;
      if (isRecord(t) && typeof t.content === 'string') viewCountText = t.content as string;
    }
    if (parts.length >= 2 && publishedText === null) {
      const t = (parts[1] as Record<string, unknown>)?.text;
      if (isRecord(t) && typeof t.content === 'string') publishedText = t.content as string;
    }
    if (viewCountText !== null && publishedText !== null) break;
  }

  // Duration from the thumbnail bottom-overlay badge. Filter to numeric
  // values so "LIVE" / "PREMIERE" / "VERIFIED" badges don't get mistaken
  // for a duration.
  let durationText: string | null = null;
  const tv = isRecord(lockup.contentImage)
    ? (lockup.contentImage.thumbnailViewModel as Record<string, unknown> | undefined)
    : undefined;
  const overlays = Array.isArray(tv?.overlays) ? tv!.overlays : [];
  outer: for (const o of overlays) {
    const bottom = (o as Record<string, unknown>)?.thumbnailBottomOverlayViewModel;
    if (!isRecord(bottom)) continue;
    const badges = Array.isArray(bottom.badges) ? bottom.badges : [];
    for (const b of badges) {
      const badge = (b as Record<string, unknown>)?.thumbnailBadgeViewModel;
      if (!isRecord(badge) || typeof badge.text !== 'string') continue;
      // m:ss or h:mm:ss
      if (/^\d+(:\d{1,2}){1,2}$/.test(badge.text)) {
        durationText = badge.text;
        break outer;
      }
    }
  }

  // Largest thumbnail source (sources are sorted small → large).
  let thumbUrl: string | null = null;
  const sources = isRecord(tv?.image) && Array.isArray((tv!.image as Record<string, unknown>).sources)
    ? ((tv!.image as Record<string, unknown>).sources as unknown[])
    : [];
  if (sources.length) {
    const last = sources[sources.length - 1];
    if (isRecord(last) && typeof last.url === 'string') thumbUrl = last.url as string;
  }

  return {
    video_id: videoId,
    url: buildWatchUrl(videoId),
    title,
    channel: null,
    channel_id: null,
    duration_text: durationText,
    published_text: publishedText,
    view_count_text: viewCountText,
    thumbnail_url: thumbUrl,
  };
}

function channelFromRenderer(renderer: Record<string, unknown>): BrowseChannel {
  const channelId = stringProp(renderer, 'channelId');
  // Modern `channelRenderer` populates `subscriberCountText` with the
  // "@handle" string and carries the real "N subscribers" string in
  // `videoCountText`. Older renderers put the subscriber count in
  // `subscriberCountText` directly. Detect an @handle to tell them apart so
  // `handle` and `subscriber_count_text` are never swapped (bug L1).
  const subText = textProp(renderer, 'subscriberCountText');
  const subTextIsHandle = !!subText && subText.startsWith('@');
  return {
    channel_id: channelId,
    url: `https://www.youtube.com/channel/${channelId}`,
    title: textProp(renderer, 'title') || 'Untitled',
    handle: channelHandle(renderer) ?? (subTextIsHandle ? subText : null),
    subscriber_count_text: subTextIsHandle
      ? textProp(renderer, 'videoCountText')
      : subText,
    thumbnail_url: thumbnailUrl(renderer),
  };
}

/**
 * Extract a channel's "@handle" from a `channelRenderer`. The real handle
 * lives at `navigationEndpoint.browseEndpoint.canonicalBaseUrl` as a
 * "/@Handle" path — `textProp` can't reach it because `navigationEndpoint` is
 * a nested object, not a text node. Returns null when no canonical @-URL is
 * present (older channels expose only a `/channel/UC…` URL).
 */
function channelHandle(renderer: Record<string, unknown>): string | null {
  const endpoint = renderer.navigationEndpoint;
  const browse = isRecord(endpoint) ? endpoint.browseEndpoint : null;
  const canonical = isRecord(browse) ? browse.canonicalBaseUrl : null;
  if (typeof canonical === 'string' && canonical.startsWith('/@')) {
    return canonical.slice(1); // "/@Handle" -> "@Handle"
  }
  return null;
}

function playlistFromRenderer(renderer: Record<string, unknown>): BrowsePlaylist {
  const playlistId = stringProp(renderer, 'playlistId');
  return {
    playlist_id: playlistId,
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
    title: textProp(renderer, 'title') || 'Untitled',
    channel: bylineText(renderer),
    video_count_text: textProp(renderer, 'videoCountText'),
    thumbnail_url: thumbnailUrl(renderer),
  };
}

function stringProp(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value === 'string' && value.trim()) return value;
  throw new ValidationError(`YouTube result is missing ${key}`);
}

function textProp(obj: Record<string, unknown>, key: string): string | null {
  return textFromUnknown(obj[key]);
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  const simple = value.simpleText;
  if (typeof simple === 'string') return simple;
  const runs = value.runs;
  if (Array.isArray(runs)) {
    const text = runs
      .map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : ''))
      .join('')
      .trim();
    return text || null;
  }
  return null;
}

function bylineText(renderer: Record<string, unknown>): string | null {
  return (
    textProp(renderer, 'ownerText') ||
    textProp(renderer, 'shortBylineText') ||
    textProp(renderer, 'longBylineText')
  );
}

function channelId(renderer: Record<string, unknown>): string | null {
  const ownerText = renderer.ownerText;
  if (!isRecord(ownerText) || !Array.isArray(ownerText.runs)) return null;
  for (const run of ownerText.runs) {
    if (!isRecord(run)) continue;
    const endpoint = run.navigationEndpoint;
    const browse = isRecord(endpoint) ? endpoint.browseEndpoint : null;
    if (isRecord(browse) && typeof browse.browseId === 'string') return browse.browseId;
  }
  return null;
}

function thumbnailUrl(renderer: Record<string, unknown>): string | null {
  const thumbnail = renderer.thumbnail;
  if (!isRecord(thumbnail) || !Array.isArray(thumbnail.thumbnails)) return null;
  const thumbnails = thumbnail.thumbnails.filter(isRecord);
  const last = thumbnails[thumbnails.length - 1];
  return typeof last?.url === 'string' ? last.url : null;
}

function thumbnailFromPlayer(details: Record<string, unknown>): string | null {
  const thumbnail = details.thumbnail;
  if (!isRecord(thumbnail) || !Array.isArray(thumbnail.thumbnails)) return null;
  const thumbnails = thumbnail.thumbnails.filter(isRecord);
  const last = thumbnails[thumbnails.length - 1];
  return typeof last?.url === 'string' ? last.url : null;
}

function normalizeChannelUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new ValidationError('channel is required');
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value.replace(/\/$/, '');
  }
  if (value.startsWith('@')) {
    return `https://www.youtube.com/${value}`;
  }
  if (value.startsWith('UC')) {
    return `https://www.youtube.com/channel/${value}`;
  }
  return `https://www.youtube.com/@${value.replace(/^@/, '')}`;
}

function extractPlaylistId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new ValidationError('playlist is required');
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed) && trimmed.length > 11) return trimmed;
  try {
    const url = new URL(trimmed);
    const id = url.searchParams.get('list');
    if (id) return id;
  } catch {
    // Fall through to validation error below.
  }
  throw new ValidationError('Could not extract a YouTube playlist ID from the supplied value');
}

function dedupeVideos(items: BrowseVideo[]): BrowseVideo[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.video_id)) return false;
    seen.add(item.video_id);
    return true;
  });
}

function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function mapValid<T>(
  items: Record<string, unknown>[],
  mapper: (item: Record<string, unknown>) => T,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    try {
      out.push(mapper(item));
    } catch {
      // YouTube mixes ads, shelves, and continuation renderers into the same
      // tree. Skip malformed entries and keep the useful results.
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
