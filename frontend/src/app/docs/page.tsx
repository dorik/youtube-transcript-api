import Link from 'next/link';
import { SiteNav } from '@/components/marketing/site-nav';
import { SiteFooter } from '@/components/marketing/site-footer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const SAMPLES = {
  curl: `# 1. Enqueue a transcript request
curl -X POST 'https://yt-transcripts-api-v2.onrender.com/v1/transcript' \\
  -H 'Authorization: Bearer yt_live_YOUR_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","format":"json"}'

# Returns 202 with a queued request. Poll until status is "completed":
curl 'https://yt-transcripts-api-v2.onrender.com/v1/transcript/REQUEST_ID' \\
  -H 'Authorization: Bearer yt_live_YOUR_KEY'`,
  node: `import axios from 'axios';

const api = axios.create({
  baseURL: 'https://yt-transcripts-api-v2.onrender.com',
  headers: { Authorization: \`Bearer \${process.env.YT_API_KEY}\` },
});

// 1. Enqueue the request
const { data: job } = await api.post('/v1/transcript', {
  url: 'https://youtu.be/dQw4w9WgXcQ',
  format: 'json',
});

// 2. Poll until the worker finishes
let result = job;
while (result.status === 'queued' || result.status === 'processing') {
  await new Promise((r) => setTimeout(r, 1500));
  ({ data: result } = await api.get(\`/v1/transcript/\${job.id}\`));
}
console.log(result.result.transcript);`,
  python: `import os, time, requests

API = "https://yt-transcripts-api-v2.onrender.com"
headers = {"Authorization": f"Bearer {os.environ['YT_API_KEY']}"}

# 1. Enqueue the request
job = requests.post(
    f"{API}/v1/transcript",
    json={"url": "https://youtu.be/dQw4w9WgXcQ", "format": "json"},
    headers=headers,
    timeout=15,
).json()

# 2. Poll until the worker finishes
result = job
while result["status"] in ("queued", "processing"):
    time.sleep(1.5)
    result = requests.get(
        f"{API}/v1/transcript/{job['id']}", headers=headers, timeout=15
    ).json()

print(result["result"]["transcript"])`,
};

const RESPONSE_SAMPLE = `{
  "id": "a1b2c3d4-5e6f-7890-abcd-ef1234567890",
  "status": "completed",
  "source": "api",
  "video_id": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  "channel": "Rick Astley",
  "credits_used": 1,
  "result": {
    "video_id": "dQw4w9WgXcQ",
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
    "channel": "Rick Astley",
    "duration": 212,
    "language": "en",
    "original_language": "en",
    "translated_to": null,
    "source": "native_captions",
    "format": "json",
    "transcript": "[♪♪♪] ♪ We're no strangers to love ♪ ...",
    "segments": [
      { "start": 1.36, "duration": 1.68, "text": "[♪♪♪]" }
    ],
    "credits_used": 1,
    "credits_remaining": 99,
    "cached": false,
    "fetched_at": "2026-05-09T08:14:07.359Z"
  },
  "created_at": "2026-05-09T08:14:05.001Z",
  "completed_at": "2026-05-09T08:14:07.412Z"
}`;

const ERROR_CODES: Array<{ code: string; status: number; meaning: string }> = [
  { code: 'MISSING_API_KEY', status: 401, meaning: 'Authorization header is missing.' },
  { code: 'INVALID_API_KEY', status: 401, meaning: 'Bearer token is malformed, revoked, or unknown.' },
  { code: 'INVALID_AUTH_SCHEME', status: 401, meaning: 'Header is present but not the Bearer scheme.' },
  { code: 'VALIDATION_ERROR', status: 400, meaning: 'Request body or query parameters failed schema validation.' },
  { code: 'METHOD_NOT_ALLOWED', status: 405, meaning: 'The path exists but not for that HTTP method (see the Allow header).' },
  { code: 'INSUFFICIENT_CREDITS', status: 402, meaning: 'Account is out of credits for this billing cycle.' },
  { code: 'NO_TRANSCRIPT', status: 404, meaning: 'Video has no captions and the Whisper fallback also produced nothing.' },
  { code: 'VIDEO_NOT_FOUND', status: 404, meaning: 'Video does not exist or is private/removed.' },
  { code: 'NOT_FOUND', status: 404, meaning: 'The transcript request or batch id does not exist (or is not yours).' },
  { code: 'ROUTE_NOT_FOUND', status: 404, meaning: 'The URL path does not match any API endpoint.' },
  { code: 'RATE_LIMIT_EXCEEDED', status: 429, meaning: 'You exceeded your per-minute request limit.' },
  { code: 'UPSTREAM_BLOCKED', status: 503, meaning: 'YouTube is temporarily blocking our servers. Retry shortly.' },
];

export default function DocsPage() {
  return (
    <>
      <SiteNav />
      <main className="container mx-auto px-4 max-w-4xl py-12">
        <h1 className="text-4xl font-bold tracking-tight mb-4">API Reference</h1>
        <p className="text-muted-foreground mb-12">
          Send a YouTube URL, get a transcript. Authenticated with a bearer API key.
        </p>

        <Section id="auth" title="Authentication">
          <p>
            Every request must include your API key in the <code>Authorization</code> header
            using the <code>Bearer</code> scheme:
          </p>
          <Code>Authorization: Bearer yt_live_YOUR_KEY</Code>
          <p>
            Create an API key from the{' '}
            <Link href="/dashboard/api-keys" className="font-medium underline">
              dashboard
            </Link>
            . Keys are shown once; store them securely.
          </p>
        </Section>

        <Section id="transcript" title="POST /v1/transcript">
          <p>
            Enqueues a transcript request for a YouTube video. The API is
            asynchronous: this call returns immediately with a{' '}
            <code>queued</code> request, and you poll{' '}
            <code>GET /v1/transcript/:id</code> until its <code>status</code> is{' '}
            <code>completed</code> (or <code>failed</code>). A request already
            served from cache comes back <code>completed</code> right away.
          </p>

          <h3 className="text-base font-semibold mt-6 mb-2">Request body (JSON)</h3>
          <ParamTable
            rows={[
              { name: 'url', type: 'string', required: true, description: 'Any standard YouTube URL or a bare 11-character video id.' },
              { name: 'format', type: 'enum', required: false, description: 'json (default), text, text-timestamps, srt, vtt.' },
              { name: 'language', type: 'string', required: false, description: 'Preferred caption language — an ISO-639 code (en, es, fr…) or "auto".' },
              { name: 'native_only', type: 'boolean', required: false, description: 'When true, skip the Whisper fallback and fail if no native captions exist.' },
              { name: 'translate_to', type: 'string', required: false, description: 'Target language for translation — an ISO-639 code, or "none" to skip.' },
            ]}
          />

          <h3 className="text-base font-semibold mt-6 mb-2">Example</h3>
          <CodeTabs samples={SAMPLES} />

          <h3 className="text-base font-semibold mt-6 mb-2">Example response (a completed request)</h3>
          <Code>{RESPONSE_SAMPLE}</Code>
          <p className="text-sm">
            While the worker runs, <code>status</code> is <code>queued</code> or{' '}
            <code>processing</code> and <code>result</code> is <code>null</code>.
            Once <code>completed</code>, <code>result</code> holds the transcript —
            including <code>original_language</code> and <code>translated_to</code>{' '}
            (non-null only when a translation was applied).
          </p>

          <h3 className="text-base font-semibold mt-6 mb-2">Response headers</h3>
          <ul className="text-sm space-y-1">
            <li><code>X-RateLimit-Limit / -Remaining / -Reset</code>: current rate-limit budget.</li>
          </ul>
        </Section>

        <Section id="browse" title="Browse endpoints">
          <p>
            The same bearer key unlocks lightweight YouTube discovery endpoints
            and the bulk-transcript queue. Discovery (list-only) endpoints
            charge one credit per video returned. The bulk endpoint charges one
            credit per transcript delivered (cache hits are free). Single-video{' '}
            <code>/v1/video/metadata</code> is one credit.
          </p>
          <ParamTable
            rows={[
              { name: 'GET /v1/search', type: 'q, type, limit', required: true, description: 'Search YouTube videos, channels, or playlists.' },
              { name: 'GET /v1/channel/search', type: 'channel, q, limit', required: true, description: 'Search videos inside a channel URL, ID, or @handle.' },
              { name: 'GET /v1/channel/videos', type: 'channel, limit', required: true, description: 'List videos from a channel.' },
              { name: 'GET /v1/channel/latest', type: 'channel, limit', required: true, description: 'List latest channel uploads.' },
              { name: 'GET /v1/playlist/videos', type: 'playlist, limit', required: true, description: 'Expand a YouTube playlist into video records.' },
              { name: 'GET /v1/video/metadata', type: 'url or video_id', required: true, description: 'Return title, channel, duration, view count, and thumbnail for one video.' },
              { name: 'POST /v1/transcripts/bulk', type: 'playlist | channel | urls, format, language, native_only, translate_to, limit', required: true, description: 'Enqueue a batch of transcripts from a playlist, channel, or URL list. One credit per transcript delivered.' },
              { name: 'GET /v1/transcripts/batches/:id', type: '(batch id in path)', required: true, description: 'Poll a bulk batch — its progress counts and per-video request rows.' },
            ]}
          />
          <p className="text-sm">
            <code>GET /v1/search</code> accepts a <code>type</code> of{' '}
            <code>video</code> (the default), <code>channel</code>,{' '}
            <code>playlist</code>, or <code>all</code>. <code>limit</code>{' '}
            defaults to 10 and is capped at 50 on every listing endpoint.
          </p>
        </Section>

        <Section id="formats" title="Output formats">
          <p>
            Pass <code>format</code> in the request body to control how the
            transcript is rendered. Every response is the JSON envelope shown
            above (<code>Content-Type: application/json</code>) — <code>format</code>{' '}
            changes the string inside <code>result.transcript</code>, not the
            response type. Write that string to a file yourself if you need a
            standalone subtitle file.
          </p>
          <ul className="text-sm space-y-1">
            <li><code>json</code> — <code>result.transcript</code> is plain text; a structured <code>segments</code> array is included alongside it.</li>
            <li><code>text</code> — plain text only, no timestamps.</li>
            <li><code>text-timestamps</code> — plain text prefixed with <code>[mm:ss]</code> per line.</li>
            <li><code>srt</code> — <code>result.transcript</code> holds SubRip-formatted subtitles.</li>
            <li><code>vtt</code> — <code>result.transcript</code> holds WebVTT-formatted subtitles.</li>
          </ul>
        </Section>

        <Section id="credits" title="Credits">
          <p>
            One credit per native YouTube transcript regardless of length. Whisper fallback
            costs one credit per minute of audio (rounded up). Cached requests are free.
          </p>
          <p>Your remaining balance is in <code>credits_remaining</code> on every JSON response.</p>
        </Section>

        <Section id="errors" title="Error codes">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Code</th>
                    <th className="px-4 py-2 font-medium">HTTP</th>
                    <th className="px-4 py-2 font-medium">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_CODES.map((e) => (
                    <tr key={e.code} className="border-b last:border-0">
                      <td className="px-4 py-2 font-mono text-xs">{e.code}</td>
                      <td className="px-4 py-2"><Badge variant="outline">{e.status}</Badge></td>
                      <td className="px-4 py-2">{e.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <p className="text-sm">
            All errors share the envelope{' '}
            <code>{'{'} error, code, message, request_id, ...details {'}'}</code>.
            Quote the <code>request_id</code> when reporting a failure so it can
            be traced in the logs.
          </p>
        </Section>

        <Section id="ratelimit" title="Rate limits">
          <p>
            Every API key gets <strong>100 requests per minute</strong> by default. The current
            window is exposed via <code>X-RateLimit-*</code> headers. Hitting the limit returns
            HTTP 429 with a <code>retry_after</code> field on the body.
          </p>
        </Section>
      </main>
      <SiteFooter />
    </>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="py-8 border-t first:border-t-0">
      <h2 className="text-2xl font-bold tracking-tight mb-4">{title}</h2>
      <div className="max-w-none space-y-4 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:rounded">
        {children}
      </div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-zinc-950 text-zinc-100 rounded-md p-4 text-xs overflow-x-auto font-mono leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function CodeTabs({ samples }: { samples: typeof SAMPLES }) {
  return (
    <Tabs defaultValue="curl">
      <TabsList>
        <TabsTrigger value="curl">curl</TabsTrigger>
        <TabsTrigger value="node">Node.js</TabsTrigger>
        <TabsTrigger value="python">Python</TabsTrigger>
      </TabsList>
      <TabsContent value="curl"><Code>{samples.curl}</Code></TabsContent>
      <TabsContent value="node"><Code>{samples.node}</Code></TabsContent>
      <TabsContent value="python"><Code>{samples.python}</Code></TabsContent>
    </Tabs>
  );
}

function ParamTable({ rows }: { rows: Array<{ name: string; type: string; required: boolean; description: string }> }) {
  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b text-muted-foreground">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Required</th>
              <th className="px-4 py-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b last:border-0">
                <td className="px-4 py-2 font-mono">{r.name}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.type}</td>
                <td className="px-4 py-2">{r.required ? 'yes' : 'no'}</td>
                <td className="px-4 py-2">{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
