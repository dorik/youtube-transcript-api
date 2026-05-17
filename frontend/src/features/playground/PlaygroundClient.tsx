"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiErrorMessage } from "@/lib/apiError";
import { listStashedKeys, getStashedKey } from "@/lib/key-stash";
import {
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from "@/lib/languages";
import { useApiKeysQuery } from "@/features/api-keys";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type {
  TranscriptRequest,
  BatchCreateResponse,
  BatchDetailResponse,
} from "@/lib/api";
import { FORMATS, type Format, type BulkResultEntry } from "./types";
import { buildCurlPreview, parseVideoLines } from "./utils";
import { ToggleRow } from "./ToggleRow";
import { ResultsCard } from "./ResultsCard";

/** Polling interval between status checks when a request is still running. */
const POLL_INTERVAL_MS = 2500;

/**
 * Enqueue one transcript request via the public API key, then poll
 * GET /v1/transcript/:id until the request reaches a terminal status
 * (`completed`, `failed`, or `canceled`). `onQueued` fires once the POST
 * is accepted, before polling begins.
 */
async function runOne(
  bearer: string,
  body: Record<string, unknown>,
  onQueued?: () => void,
): Promise<TranscriptRequest> {
  const created = await api<TranscriptRequest>("/v1/transcript", {
    method: "POST",
    body,
    bearer,
  });
  onQueued?.();
  let current = created;
  while (current.status === "queued" || current.status === "processing") {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    current = await api<TranscriptRequest>(`/v1/transcript/${created.id}`, {
      bearer,
    });
  }
  return current;
}

/**
 * Enqueue a playlist/channel/URL-list batch via POST /v1/transcripts/bulk, then
 * poll GET /v1/transcripts/batches/:id until every entry reaches a terminal
 * status. Returns the final request list. `onQueued` fires once the batch
 * POST is accepted, before polling begins.
 */
async function runBulk(
  bearer: string,
  body: Record<string, unknown>,
  onQueued?: () => void,
): Promise<TranscriptRequest[]> {
  const created = await api<BatchCreateResponse>("/v1/transcripts/bulk", {
    method: "POST",
    body,
    bearer,
  });
  onQueued?.();
  const batchId = created.batch.id;
  let requests = created.requests;
  while (
    requests.some((r) => r.status === "queued" || r.status === "processing")
  ) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    const detail = await api<BatchDetailResponse>(
      `/v1/transcripts/batches/${batchId}`,
      { bearer },
    );
    requests = detail.requests;
  }
  return requests;
}

export function PlaygroundClient() {
  // Start empty — the Textarea's `placeholder` already shows an example
  // URL so users can see the expected format without it being a "real"
  // value they have to delete before pasting their own.
  const [videosText, setVideosText] = useState("");
  const [format, setFormat] = useState<Format>("json");
  const [language, setLanguage] = useState("auto");
  const [translateTo, setTranslateTo] = useState("none");
  const [nativeOnly, setNativeOnly] = useState(false);
  const [showTimestamps, setShowTimestamps] = useState(true);

  // API key picker — backend is the source of truth; we list real keys and
  // look up plaintext from a browser-local stash. If the plaintext for the
  // chosen key isn't available (e.g. created in another browser), the
  // playground requires a key with stashed plaintext (there is no
  // cookie-auth fallback for the public /v1/transcript endpoint).
  const [selectedKeyId, setSelectedKeyId] = useState<string>("");
  const [manualKey, setManualKey] = useState("");
  const [showManual, setShowManual] = useState(false);

  const [tab, setTab] = useState<"videos" | "playlist" | "channel">("videos");
  const [playlistInput, setPlaylistInput] = useState("");
  const [channelInput, setChannelInput] = useState("");
  const [channelQuery, setChannelQuery] = useState("");
  const [channelMode, setChannelMode] = useState<
    "videos" | "latest" | "search"
  >("latest");
  const [browseLimit, setBrowseLimit] = useState(5);

  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BulkResultEntry[] | null>(null);
  const [activeResultIdx, setActiveResultIdx] = useState(0);

  const apiKeysQuery = useApiKeysQuery();
  const serverKeys = useMemo(
    () => apiKeysQuery.data?.keys.filter((k) => !k.is_revoked) ?? [],
    [apiKeysQuery.data?.keys],
  );

  // Pick a default server-side key when the query resolves.
  useEffect(() => {
    if (serverKeys.length === 0) return;
    // Prefer a key we actually have plaintext for; falls back to the
    // most recent so the user can still pick something even without it.
    const stashed = listStashedKeys();
    const usable = serverKeys.find((k) => stashed.some((s) => s.id === k.id));
    setSelectedKeyId((prev) => prev || usable?.id || serverKeys[0].id);
  }, [serverKeys]);

  const videoList = useMemo(() => parseVideoLines(videosText), [videosText]);

  // Plaintext for the currently selected server key, if we stashed it
  // locally at creation time. Null if the user has nothing selected or we
  // don't have plaintext available. The public /v1/transcript endpoint
  // requires Bearer auth — there is no cookie fallback.
  const selectedPlaintext = useMemo(() => {
    if (showManual) return manualKey.trim() || null;
    if (!selectedKeyId) return null;
    return getStashedKey(selectedKeyId)?.plaintext ?? null;
  }, [selectedKeyId, manualKey, showManual]);

  // Auth mode for the next request — bearer when we have plaintext, or
  // unavailable (the public endpoint has no session fallback).
  const authMode: "bearer" | "unavailable" = selectedPlaintext
    ? "bearer"
    : "unavailable";

  // Submit button gating. Mirrors the early-return guards in onSubmit so
  // the button visibly reflects what the server would accept, instead of
  // letting the user click and seeing a toast.error round-trip.
  const noKeySelected = showManual ? !manualKey.trim() : !selectedKeyId;
  const noUsableKey = !selectedPlaintext;
  const submitDisabled = submitting || noKeySelected || noUsableKey;
  const submitDisabledReason = noKeySelected
    ? showManual
      ? "Paste an API key to enable"
      : "Select an API key to enable"
    : noUsableKey
      ? "Select an API key with a stored plaintext value to use the public API."
      : undefined;

  const curlPreview = useMemo(() => {
    const opts = {
      format,
      language,
      nativeOnly,
      translateTo,
      bearerPlaintext: selectedPlaintext,
    };
    if (tab === "playlist") {
      return buildCurlPreview({
        mode: "playlist",
        playlist: playlistInput,
        limit: browseLimit,
        ...opts,
      });
    }
    if (tab === "channel") {
      return buildCurlPreview({
        mode: "channel",
        channel: channelInput,
        channelMode,
        channelQuery,
        limit: browseLimit,
        ...opts,
      });
    }
    return buildCurlPreview({
      mode: "video",
      firstUrl: videoList[0]?.url ?? null,
      ...opts,
    });
  }, [
    tab,
    videoList,
    playlistInput,
    channelInput,
    channelMode,
    channelQuery,
    browseLimit,
    format,
    language,
    nativeOnly,
    translateTo,
    selectedPlaintext,
  ]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedPlaintext) {
        toast.error(
          "A plaintext API key is required. Paste one or pick a key created in this browser.",
        );
        return;
      }

      const sharedOptions = (): Record<string, unknown> => ({
        format,
        language: language === "auto" ? undefined : language,
        native_only: nativeOnly || undefined,
        translate_to: translateTo === "none" ? undefined : translateTo,
      });

      // Map a settled TranscriptRequest to a result row.
      const toEntry = (r: TranscriptRequest): BulkResultEntry =>
        r.status === "completed" && r.result
          ? {
              url: r.request.url,
              ok: true,
              data: r.result,
              requestId: r.id,
            }
          : {
              url: r.request.url,
              ok: false,
              error: r.error_message ?? "Request failed",
            };

      // Fires once the first request is accepted by the server. Results
      // keep streaming into the card below, but the input fields clear so
      // the next batch can be pasted straight away. Configuration (key,
      // format, languages) is intentionally kept.
      let queuedAnnounced = false;
      const announceQueued = () => {
        if (queuedAnnounced) return;
        queuedAnnounced = true;
        toast.success(
          "Request queued — results will appear below as they finish.",
        );
        setVideosText("");
        setPlaylistInput("");
        setChannelInput("");
        setChannelQuery("");
      };

      setSubmitting(true);
      setResults([]);
      setActiveResultIdx(0);

      try {
        if (tab === "videos") {
          if (videoList.length === 0) {
            toast.error("Add at least one YouTube URL or video ID.");
            return;
          }
          const acc: BulkResultEntry[] = [];
          for (const v of videoList) {
            try {
              const current = await runOne(
                selectedPlaintext,
                { url: v.url, ...sharedOptions() },
                announceQueued,
              );
              acc.push(toEntry(current));
            } catch (err) {
              acc.push({
                url: v.url,
                ok: false,
                error: getApiErrorMessage(err, "Request failed"),
              });
            }
            setResults([...acc]);
          }
          return;
        }

        // Playlist / channel: one bulk POST, then poll the batch.
        let body: Record<string, unknown>;
        if (tab === "playlist") {
          if (!playlistInput.trim()) {
            toast.error("Paste a playlist URL or ID.");
            return;
          }
          body = {
            playlist: playlistInput.trim(),
            limit: browseLimit,
            ...sharedOptions(),
          };
        } else {
          if (!channelInput.trim()) {
            toast.error("Paste a channel URL, ID, or handle.");
            return;
          }
          if (channelMode === "search" && !channelQuery.trim()) {
            toast.error("Enter a search query for channel search mode.");
            return;
          }
          body = {
            channel: channelInput.trim(),
            channelMode,
            limit: browseLimit,
            ...(channelMode === "search"
              ? { channelQuery: channelQuery.trim() }
              : {}),
            ...sharedOptions(),
          };
        }
        try {
          const requests = await runBulk(
            selectedPlaintext,
            body,
            announceQueued,
          );
          setResults(requests.map(toEntry));
        } catch (err) {
          toast.error(getApiErrorMessage(err, "Could not run the batch"));
          setResults(null);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      selectedPlaintext,
      tab,
      videoList,
      playlistInput,
      channelInput,
      channelMode,
      channelQuery,
      browseLimit,
      format,
      language,
      nativeOnly,
      translateTo,
    ],
  );

  const handleCopyPreview = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(curlPreview);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
  }, [curlPreview]);

  return (
    <div className="max-w-7xl">
      <h1 className="text-4xl font-bold tracking-tight mb-2">Playground</h1>
      <p className="text-muted-foreground mb-8">
        Try the API live. Paste URLs, pick a saved key, hit Fetch.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ----- Request ----- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Request configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              {/* API key picker — backed by /me/api-keys. Each item shows
                    name + prefix; we look up plaintext from the local stash
                    when sending. The public /v1/transcript endpoint requires
                    Bearer auth; there is no session fallback. */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>API key</Label>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                    onClick={() => setShowManual((v) => !v)}
                  >
                    {showManual
                      ? "Pick from your keys"
                      : "Paste a different key"}
                  </button>
                </div>

                {showManual ? (
                  <Input
                    type="password"
                    placeholder="yt_live_..."
                    value={manualKey}
                    onChange={(e) => setManualKey(e.target.value)}
                  />
                ) : apiKeysQuery.isLoading ? (
                  <Skeleton className="h-9" />
                ) : serverKeys.length === 0 ? (
                  <div className="rounded-md border border-dashed bg-muted/30 p-3 text-sm">
                    <p className="text-muted-foreground">
                      You don&apos;t have any API keys yet.{" "}
                      <Link
                        href="/dashboard/api-keys"
                        className="font-medium text-foreground underline"
                      >
                        Create one
                      </Link>{" "}
                      — new keys auto-save here for one-click reuse.
                    </p>
                  </div>
                ) : (
                  <Select
                    value={selectedKeyId}
                    onValueChange={setSelectedKeyId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select an API key" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {serverKeys.map((k) => {
                        const stashed = !!getStashedKey(k.id);
                        return (
                          <SelectItem key={k.id} value={k.id}>
                            <span className="flex items-center justify-between gap-3 w-full">
                              <span className="truncate">
                                {k.name ?? "Untitled"}
                                <span className="text-muted-foreground">
                                  {" "}
                                  · yt_live_
                                  {k.prefix ?? "????"}
                                </span>
                              </span>
                              {!stashed && (
                                <span className="text-[10px] text-muted-foreground border rounded px-1 py-0.5">
                                  no plaintext
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}

                {/* Status note explaining auth availability. */}
                {!showManual && serverKeys.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {authMode === "bearer" ? (
                      <>
                        Using{" "}
                        <code className="font-mono">
                          Authorization: Bearer …
                        </code>{" "}
                        for this key.
                      </>
                    ) : (
                      <>
                        Plaintext for this key isn&apos;t stored in this
                        browser. Pick a key created here, or paste one directly.
                      </>
                    )}
                  </p>
                )}
              </div>

              {/* Format */}
              <div className="space-y-2">
                <Label>Format</Label>
                <Select
                  value={format}
                  onValueChange={(v) => setFormat(v as Format)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Languages: source + target. */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <span aria-hidden>🎙️</span> Audio language
                  </Label>
                  <SearchableSelect
                    value={language}
                    onValueChange={setLanguage}
                    options={SOURCE_LANGUAGE_OPTIONS.map((l) => ({
                      value: l.code,
                      label: l.label,
                    }))}
                    searchPlaceholder="Search languages…"
                    aria-label="Audio language"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <span aria-hidden>🌐</span> Translate to
                  </Label>
                  <SearchableSelect
                    value={translateTo}
                    onValueChange={setTranslateTo}
                    options={TARGET_LANGUAGE_OPTIONS.map((l) => ({
                      value: l.code,
                      label: l.label,
                    }))}
                    searchPlaceholder="Search languages…"
                    aria-label="Translate to"
                  />
                  {translateTo !== "none" && (
                    <p className="text-xs text-muted-foreground">
                      Translation costs <strong>+1 credit</strong> per video, on
                      top of the normal fetch cost.
                    </p>
                  )}
                </div>
              </div>

              {/* Toggles */}
              <ToggleRow
                icon="🎬"
                title="Native Captions Only"
                subtitle="Skip Whisper fallback · 1 credit per video"
                checked={nativeOnly}
                onChange={setNativeOnly}
              />
              <ToggleRow
                icon="⏱"
                title="Show timestamps in viewer"
                subtitle="Render the response with [HH:MM] prefixes"
                checked={showTimestamps}
                onChange={setShowTimestamps}
              />

              <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                <TabsList className="w-full grid grid-cols-3">
                  <TabsTrigger value="videos">Videos</TabsTrigger>
                  <TabsTrigger value="playlist">Playlist</TabsTrigger>
                  <TabsTrigger value="channel">Channel</TabsTrigger>
                </TabsList>

                <TabsContent value="videos" className="mt-3 space-y-2">
                  <Label htmlFor="urls">
                    YouTube video URLs or IDs (one per line)
                  </Label>
                  <Textarea
                    id="urls"
                    rows={5}
                    placeholder={
                      "https://youtu.be/dQw4w9WgXcQ\nhttps://www.youtube.com/watch?v=..."
                    }
                    value={videosText}
                    onChange={(e) => setVideosText(e.target.value)}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    {videoList.length} video{videoList.length === 1 ? "" : "s"}{" "}
                    detected
                  </p>
                </TabsContent>

                <TabsContent value="playlist" className="mt-3 space-y-2">
                  <Label htmlFor="playlist">Playlist URL or ID</Label>
                  <Input
                    id="playlist"
                    placeholder="https://www.youtube.com/playlist?list=..."
                    value={playlistInput}
                    onChange={(e) => setPlaylistInput(e.target.value)}
                  />
                </TabsContent>

                <TabsContent value="channel" className="mt-3 space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="channel">Channel URL, ID, or handle</Label>
                    <Input
                      id="channel"
                      placeholder="@mkbhd or https://www.youtube.com/@mkbhd"
                      value={channelInput}
                      onChange={(e) => setChannelInput(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Channel mode</Label>
                    <Select
                      value={channelMode}
                      onValueChange={(v) =>
                        setChannelMode(v as typeof channelMode)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="latest">Latest uploads</SelectItem>
                        <SelectItem value="videos">All videos</SelectItem>
                        <SelectItem value="search">
                          Search in channel
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {channelMode === "search" && (
                    <div className="space-y-2">
                      <Label htmlFor="channel-query">Search query</Label>
                      <Input
                        id="channel-query"
                        placeholder="interview, tutorial, launch..."
                        value={channelQuery}
                        onChange={(e) => setChannelQuery(e.target.value)}
                      />
                    </div>
                  )}
                </TabsContent>
              </Tabs>

              {tab !== "videos" && (
                <div className="grid gap-3 sm:grid-cols-[1fr_96px] sm:items-end">
                  <p className="text-xs text-muted-foreground">
                    Expands the playlist/channel on the server, queues a
                    transcript per video, then polls until each finishes.
                  </p>
                  <div className="space-y-1">
                    <Label htmlFor="browse-limit" className="text-xs">
                      Limit
                    </Label>
                    {/* Capped at 25 for the playground only, to keep the demo's
                          poll loop snappy. The backend allows up to 100 (BATCH_VIDEO_CAP). */}
                    <Input
                      id="browse-limit"
                      type="number"
                      min={1}
                      max={25}
                      value={browseLimit}
                      onChange={(e) =>
                        setBrowseLimit(
                          Math.min(
                            25,
                            Math.max(1, Number(e.target.value) || 1),
                          ),
                        )
                      }
                    />
                  </div>
                </div>
              )}

              <Button
                type="submit"
                disabled={submitDisabled}
                className="w-full"
                title={submitDisabledReason}
              >
                {submitting
                  ? `Fetching ${results?.length ?? 0}…`
                  : "Fetch transcript"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ----- Response ----- */}
        <div className="space-y-4">
          <ResultsCard
            results={results}
            submitting={submitting}
            activeIdx={activeResultIdx}
            onSelect={setActiveResultIdx}
            showTimestamps={showTimestamps}
          />

          {/* cURL preview */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">cURL Command</CardTitle>
              <Button variant="ghost" size="sm" onClick={handleCopyPreview}>
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                Copy
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="bg-zinc-950 text-zinc-100 rounded-md p-3 text-xs overflow-x-auto font-mono leading-relaxed">
                <code>{curlPreview}</code>
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
