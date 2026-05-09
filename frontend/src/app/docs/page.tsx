import Link from 'next/link';
import { SiteNav } from '@/components/marketing/site-nav';
import { SiteFooter } from '@/components/marketing/site-footer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const SAMPLES = {
  curl: `curl 'https://api.youtubetranscripts.co/v1/transcript?url=https://youtu.be/dQw4w9WgXcQ&format=json' \\
  -H 'Authorization: Bearer yt_live_YOUR_KEY'`,
  node: `import axios from 'axios';

const { data } = await axios.get(
  'https://api.youtubetranscripts.co/v1/transcript',
  {
    params: { url: 'https://youtu.be/dQw4w9WgXcQ', format: 'json' },
    headers: { Authorization: \`Bearer \${process.env.YT_API_KEY}\` },
  },
);
console.log(data.transcript);`,
  python: `import os
import requests

resp = requests.get(
    "https://api.youtubetranscripts.co/v1/transcript",
    params={"url": "https://youtu.be/dQw4w9WgXcQ", "format": "json"},
    headers={"Authorization": f"Bearer {os.environ['YT_API_KEY']}"},
    timeout=15,
)
resp.raise_for_status()
print(resp.json()["transcript"])`,
};

const RESPONSE_SAMPLE = `{
  "video_id": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  "channel": "Rick Astley",
  "duration": 212,
  "language": "en",
  "source": "native_captions",
  "format": "json",
  "transcript": "[♪♪♪] ♪ We're no strangers to love ♪ ♪ You know the rules and so do I ♪ ...",
  "segments": [
    { "start": 1.36,  "duration": 1.68, "text": "[♪♪♪]" },
    { "start": 18.64, "duration": 3.24, "text": "♪ We're no strangers to love ♪" }
  ],
  "credits_used": 1,
  "credits_remaining": 99,
  "cached": false,
  "fetched_at": "2026-05-09T08:14:07.359Z"
}`;

const ERROR_CODES: Array<{ code: string; status: number; meaning: string }> = [
  { code: 'MISSING_API_KEY', status: 401, meaning: 'Authorization header is missing.' },
  { code: 'INVALID_API_KEY', status: 401, meaning: 'Bearer token is malformed, revoked, or unknown.' },
  { code: 'INVALID_AUTH_SCHEME', status: 401, meaning: 'Header is present but not Bearer.' },
  { code: 'VALIDATION_ERROR', status: 400, meaning: 'Query parameters failed schema validation.' },
  { code: 'INSUFFICIENT_CREDITS', status: 402, meaning: 'Account is out of credits for this billing cycle.' },
  { code: 'NO_TRANSCRIPT', status: 404, meaning: 'Video has no captions and Whisper also failed.' },
  { code: 'VIDEO_NOT_FOUND', status: 404, meaning: 'Video does not exist or is private/removed.' },
  { code: 'RATE_LIMIT_EXCEEDED', status: 429, meaning: 'You exceeded your per-minute request limit.' },
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

        <Section id="get-transcript" title="GET /v1/transcript">
          <p>Fetches the transcript for a YouTube video.</p>

          <h3 className="text-base font-semibold mt-6 mb-2">Query parameters</h3>
          <ParamTable
            rows={[
              { name: 'url', type: 'string', required: true, description: 'Any standard YouTube URL or a bare 11-character video id.' },
              { name: 'format', type: 'enum', required: false, description: 'json (default), text, text-timestamps, srt, vtt' },
              { name: 'language', type: 'string', required: false, description: 'ISO-639 language code (e.g. en, es, fr) or "auto".' },
            ]}
          />

          <h3 className="text-base font-semibold mt-6 mb-2">Example request</h3>
          <CodeTabs samples={SAMPLES} />

          <h3 className="text-base font-semibold mt-6 mb-2">Example response</h3>
          <Code>{RESPONSE_SAMPLE}</Code>

          <h3 className="text-base font-semibold mt-6 mb-2">Response headers</h3>
          <ul className="text-sm space-y-1">
            <li><code>X-Transcript-Source</code>: <code>native_captions</code> or <code>whisper</code>.</li>
            <li><code>X-Transcript-Cached</code>: <code>1</code> when served from cache, <code>0</code> when freshly fetched.</li>
            <li><code>X-RateLimit-Limit / -Remaining / -Reset</code>: current rate limit budget.</li>
          </ul>
        </Section>

        <Section id="formats" title="Output formats">
          <p>
            Pass <code>format=&lt;value&gt;</code> to control the response body. JSON is the
            default; the others return the raw transcript with the appropriate
            <code> Content-Type</code> for direct use as a file.
          </p>
          <ul className="text-sm space-y-1">
            <li><code>json</code> — full envelope with title, segments, credits info.</li>
            <li><code>text</code> — plain text only, no timestamps.</li>
            <li><code>text-timestamps</code> — plain text prefixed with <code>[mm:ss]</code> per line.</li>
            <li><code>srt</code> — SubRip subtitles (Content-Type: <code>application/x-subrip</code>).</li>
            <li><code>vtt</code> — WebVTT (Content-Type: <code>text/vtt</code>).</li>
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
            All errors share the envelope <code>{'{'} error, code, message, ...details {'}'}</code>.
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
      <div className="prose prose-sm max-w-none space-y-4 [&_code]:font-mono [&_code]:bg-muted [&_code]:px-1 [&_code]:rounded">
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
