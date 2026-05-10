'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ExternalLink, Copy } from 'lucide-react';
import { SiteNav } from '@/components/marketing/site-nav';
import { SiteFooter } from '@/components/marketing/site-footer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  API_BASE_URL,
  apiKeys as apiKeysClient,
  transcripts,
  TranscriptResponse,
  TranscriptSegment,
  type ApiKey,
} from '@/lib/api';
import { getApiErrorMessage } from '@/lib/apiError';
import { listStashedKeys, getStashedKey } from '@/lib/key-stash';
import { SOURCE_LANGUAGE_OPTIONS, TARGET_LANGUAGE_OPTIONS } from '@/lib/languages';

const FORMATS = ['json', 'text', 'text-timestamps', 'srt', 'vtt'] as const;
type Format = (typeof FORMATS)[number];

interface BulkResultEntry {
  url: string;
  ok: boolean;
  data?: TranscriptResponse;
  error?: string;
}

export default function PlaygroundPage() {
  const [tab, setTab] = useState<'videos' | 'playlist' | 'channel'>('videos');
  const [videosText, setVideosText] = useState(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
  const [format, setFormat] = useState<Format>('json');
  const [language, setLanguage] = useState('auto');
  const [translateTo, setTranslateTo] = useState('none');
  const [nativeOnly, setNativeOnly] = useState(false);
  const [showTimestamps, setShowTimestamps] = useState(true);

  // API key picker — backend is the source of truth; we list real keys and
  // look up plaintext from a browser-local stash. If the plaintext for the
  // chosen key isn't available (e.g. created in another browser), we fall
  // back to cookie-authed /me/transcript so the playground still works.
  const [serverKeys, setServerKeys] = useState<ApiKey[] | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string>('');
  const [manualKey, setManualKey] = useState('');
  const [showManual, setShowManual] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BulkResultEntry[] | null>(null);
  const [activeResultIdx, setActiveResultIdx] = useState(0);

  // Hydrate server-side keys for the dropdown.
  useEffect(() => {
    apiKeysClient
      .list()
      .then(({ keys }) => {
        const active = keys.filter((k) => !k.is_revoked);
        setServerKeys(active);
        if (active.length > 0) {
          // Prefer a key we actually have plaintext for; falls back to the
          // most recent so the user can still pick something even without it.
          const stashed = listStashedKeys();
          const usable = active.find((k) => stashed.some((s) => s.id === k.id));
          setSelectedKeyId((prev) => prev || usable?.id || active[0].id);
        }
      })
      .catch(() => setServerKeys([]));
  }, []);

  const videoList = useMemo(() => parseVideoLines(videosText), [videosText]);

  // Plaintext for the currently selected server key, if we stashed it
  // locally at creation time. Null if the user has nothing selected or we
  // don't have plaintext available.
  const selectedPlaintext = useMemo(() => {
    if (showManual) return manualKey.trim() || null;
    if (!selectedKeyId) return null;
    return getStashedKey(selectedKeyId)?.plaintext ?? null;
  }, [selectedKeyId, manualKey, showManual]);

  // Auth mode for the next request — bearer when we have plaintext, cookie
  // session otherwise. Shown to the user as a small note.
  const authMode: 'bearer' | 'session' = selectedPlaintext ? 'bearer' : 'session';

  // The cURL we display always shows the public-API form, regardless of
  // which auth path the in-browser request takes — that's the snippet a
  // developer would paste into their own code.
  const curlPreview = useMemo(() => {
    const params = new URLSearchParams();
    params.set('url', videoList[0]?.url ?? '<URL>');
    if (format !== 'json') params.set('format', format);
    if (language !== 'auto') params.set('language', language);
    if (nativeOnly) params.set('native_only', 'true');
    if (translateTo !== 'none') params.set('translate_to', translateTo);
    const keyPlaceholder = selectedPlaintext
      ? `${selectedPlaintext.slice(0, 12)}...`
      : 'yt_live_YOUR_KEY';
    return [
      `curl '${apiBase()}/v1/transcript?${params.toString()}' \\`,
      `  -H 'Authorization: Bearer ${keyPlaceholder}'`,
    ].join('\n');
  }, [videoList, format, language, nativeOnly, translateTo, selectedPlaintext]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (tab !== 'videos') {
      toast.info('Playlist and Channel inputs ship with the Jobs feature.');
      return;
    }
    if (videoList.length === 0) {
      toast.error('Add at least one YouTube URL or video ID.');
      return;
    }
    if (showManual && !manualKey.trim()) {
      toast.error('Paste an API key or pick one from the dropdown.');
      return;
    }
    setSubmitting(true);
    setResults([]);
    setActiveResultIdx(0);

    // Sequential processing so one bad URL doesn't poison the rest, and so
    // the user gets feedback as each one finishes.
    const acc: BulkResultEntry[] = [];
    for (const v of videoList) {
      try {
        const params = {
          url: v.url,
          format,
          language: language === 'auto' ? undefined : language,
          native_only: nativeOnly,
          translate_to: translateTo === 'none' ? undefined : translateTo,
        };
        const data = selectedPlaintext
          ? await transcripts.fetch(selectedPlaintext, params)
          : await transcripts.fetchAsUser(params);
        acc.push({ url: v.url, ok: true, data });
      } catch (err) {
        acc.push({
          url: v.url,
          ok: false,
          error: getApiErrorMessage(err, 'Request failed'),
        });
      }
      setResults([...acc]);
    }
    setSubmitting(false);
  }

  return (
    <>
      <SiteNav />
      <main className="container mx-auto px-4 max-w-7xl py-12">
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
                    when sending, and gracefully fall back to session auth
                    when not available. */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>API key</Label>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                      onClick={() => setShowManual((v) => !v)}
                    >
                      {showManual ? 'Pick from your keys' : 'Paste a different key'}
                    </button>
                  </div>

                  {showManual ? (
                    <Input
                      type="password"
                      placeholder="yt_live_..."
                      value={manualKey}
                      onChange={(e) => setManualKey(e.target.value)}
                    />
                  ) : serverKeys === null ? (
                    <Skeleton className="h-9" />
                  ) : serverKeys.length === 0 ? (
                    <div className="rounded-md border border-dashed bg-muted/30 p-3 text-sm">
                      <p className="text-muted-foreground">
                        You don&apos;t have any API keys yet.{' '}
                        <Link href="/dashboard/api-keys" className="font-medium text-foreground underline">
                          Create one
                        </Link>{' '}
                        — new keys auto-save here for one-click reuse.
                      </p>
                    </div>
                  ) : (
                    <Select value={selectedKeyId} onValueChange={setSelectedKeyId}>
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
                                  {k.name ?? 'Untitled'}
                                  <span className="text-muted-foreground"> · yt_live_{k.prefix ?? '????'}</span>
                                </span>
                                {!stashed && (
                                  <span className="text-[10px] text-muted-foreground border rounded px-1 py-0.5">
                                    session auth
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  )}

                  {/* Status note explaining which auth path will be used. */}
                  {!showManual && serverKeys && serverKeys.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {authMode === 'bearer' ? (
                        <>
                          Using <code className="font-mono">Authorization: Bearer …</code>{' '}
                          for this key.
                        </>
                      ) : (
                        <>
                          Plaintext for this key isn&apos;t stored in this browser, so the request
                          will use your dashboard session instead. Both paths bill the same account.
                        </>
                      )}
                    </p>
                  )}
                </div>

                {/* Format */}
                <div className="space-y-2">
                  <Label>Format</Label>
                  <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FORMATS.map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Languages: source + target. Source picks which audio
                    language to fetch / detect; target asks for an optional
                    translation (wired in Feature 4 — for now we surface a
                    toast if the user asks for one). */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <span aria-hidden>🎙️</span> Audio language
                    </Label>
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        {SOURCE_LANGUAGE_OPTIONS.map((l) => (
                          <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <span aria-hidden>🌐</span> Translate to
                    </Label>
                    <Select value={translateTo} onValueChange={setTranslateTo}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        {TARGET_LANGUAGE_OPTIONS.map((l) => (
                          <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {translateTo !== 'none' && (
                      <p className="text-xs text-muted-foreground">
                        Translation costs <strong>+1 credit</strong> per video, on top of the
                        normal fetch cost.
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

                {/* Tabs */}
                <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                  <TabsList className="w-full grid grid-cols-3">
                    <TabsTrigger value="videos">Videos</TabsTrigger>
                    <TabsTrigger value="playlist">Playlist</TabsTrigger>
                    <TabsTrigger value="channel">Channel</TabsTrigger>
                  </TabsList>
                  <TabsContent value="videos" className="mt-3 space-y-2">
                    <Label htmlFor="urls">YouTube video URLs or IDs (one per line)</Label>
                    <Textarea
                      id="urls"
                      rows={5}
                      placeholder={'https://youtu.be/dQw4w9WgXcQ\nhttps://www.youtube.com/watch?v=...'}
                      value={videosText}
                      onChange={(e) => setVideosText(e.target.value)}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {videoList.length} video{videoList.length === 1 ? '' : 's'} detected
                    </p>
                  </TabsContent>
                  <TabsContent value="playlist" className="mt-3">
                    <PendingFeatureNotice
                      what="Playlist input"
                      label="playlist URL"
                    />
                  </TabsContent>
                  <TabsContent value="channel" className="mt-3">
                    <PendingFeatureNotice
                      what="Channel input"
                      label="channel URL or @handle"
                    />
                  </TabsContent>
                </Tabs>

                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? `Fetching ${results?.length ?? 0}/${videoList.length}…` : 'Fetch transcript'}
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
              language={language}
              translateTo={translateTo}
            />

            {/* cURL preview */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">cURL Command</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(curlPreview);
                    toast.success('Copied');
                  }}
                >
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
      </main>
      <SiteFooter />
    </>
  );
}

/* ---------------- Helpers ---------------- */

function ToggleRow({
  icon,
  title,
  subtitle,
  checked,
  onChange,
}: {
  icon: string;
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between border rounded-md px-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors">
      <div className="flex items-center gap-3">
        <span className="text-lg" aria-hidden>{icon}</span>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer"
      />
    </label>
  );
}

function PendingFeatureNotice({ what, label }: { what: string; label: string }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
      <p className="font-medium text-foreground mb-1">{what} ships with the Jobs feature</p>
      <p>
        Once async jobs land, paste a {label} here to fetch every video at once.
        For now, expand it manually and paste the video URLs in the Videos tab.
      </p>
    </div>
  );
}

function ResultsCard({
  results,
  submitting,
  activeIdx,
  onSelect,
  showTimestamps,
  language,
  translateTo,
}: {
  results: BulkResultEntry[] | null;
  submitting: boolean;
  activeIdx: number;
  onSelect: (i: number) => void;
  showTimestamps: boolean;
  language: string;
  translateTo: string;
}) {
  if (results === null && !submitting) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Response</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Fill in the form on the left and hit Fetch.
          </p>
        </CardContent>
      </Card>
    );
  }

  const active = results?.[activeIdx];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          Response
          {active?.ok && active.data?.cached && <Badge variant="secondary">cached</Badge>}
          {active?.ok && active.data && <Badge variant="outline">{active.data.source}</Badge>}
          {active?.ok && active.data?.translated_to && (
            <Badge variant="default" className="bg-blue-600 hover:bg-blue-600">
              {active.data.original_language} → {active.data.translated_to}
              {active.data.translation_stubbed ? ' (stub)' : ''}
            </Badge>
          )}
          {active?.ok && active.data && (
            <Link
              href={(() => {
                const qs = new URLSearchParams({ url: active.url });
                if (language !== 'auto') qs.set('language', language);
                if (translateTo !== 'none') qs.set('translate_to', translateTo);
                return `/dashboard/transcripts?${qs.toString()}`;
              })()}
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
            >
              Open in viewer
              <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Result tabs (one per submitted URL) */}
        {results && results.length > 1 && (
          <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
            {results.map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(i)}
                className={`text-xs px-2.5 py-1 rounded-md whitespace-nowrap transition-colors ${
                  i === activeIdx
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {r.ok ? '✓' : '✗'} {shortVideoId(r.url)}
              </button>
            ))}
          </div>
        )}

        {submitting && !active ? (
          <Skeleton className="h-72" />
        ) : !active ? (
          <Skeleton className="h-72" />
        ) : !active.ok ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-medium mb-1">Failed: {shortVideoId(active.url)}</p>
            <p>{active.error}</p>
          </div>
        ) : active.data ? (
          <RenderedResult data={active.data} showTimestamps={showTimestamps} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RenderedResult({
  data,
  showTimestamps,
}: {
  data: TranscriptResponse;
  showTimestamps: boolean;
}) {
  // For raw subtitle / text formats the API returns string-typed transcript;
  // we just dump it. JSON format gets a nicer rendered list.
  const isJsonFormat = data.format === 'json';

  if (!isJsonFormat || !data.segments) {
    return (
      <pre className="bg-zinc-950 text-zinc-100 rounded-md p-4 text-xs overflow-auto max-h-[500px] font-mono leading-relaxed">
        <code>{typeof data === 'string' ? data : JSON.stringify(data, null, 2)}</code>
      </pre>
    );
  }

  return (
    <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
      <div className="text-sm">
        <p className="font-semibold truncate">{data.title}</p>
        <p className="text-xs text-muted-foreground">
          {data.channel} · {data.language} · {data.segments.length} segments · credits used: {data.credits_used}
        </p>
      </div>
      <div className="border rounded-md divide-y bg-background">
        {data.segments.map((seg: TranscriptSegment) => (
          <div key={seg.start} className="flex gap-3 px-3 py-2 text-sm">
            {showTimestamps && (
              <span className="font-mono text-xs text-muted-foreground tabular-nums shrink-0 mt-0.5">
                {formatTimestamp(seg.start)}
              </span>
            )}
            <span>{seg.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Util ---------------- */

function parseVideoLines(text: string): Array<{ url: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => ({ url }));
}

function shortVideoId(url: string): string {
  // Pull a video id out of the URL for the tab label, falling back to the
  // raw URL (truncated) if we can't parse one.
  const m =
    url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ??
    url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/\/embed\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : url.slice(0, 14) + (url.length > 14 ? '…' : '');
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function apiBase(): string {
  return API_BASE_URL;
}
