import Link from 'next/link';
import { SiteNav } from '@/components/marketing/site-nav';
import { SiteFooter } from '@/components/marketing/site-footer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const SNIPPETS = {
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

const FEATURES = [
  {
    title: 'Sub-100ms cached responses',
    body: 'Aggressive Redis caching means a video fetched once is served instantly to every customer who asks for it next.',
  },
  {
    title: 'Whisper fallback included',
    body: 'No native captions? We auto-transcribe with OpenAI Whisper at 1 credit per minute. No premium tier upcharge.',
  },
  {
    title: '100+ languages',
    body: 'Auto-detect or request a specific language. Same endpoint, same response shape.',
  },
  {
    title: 'JSON · Text · SRT · VTT',
    body: "Pick the output format that fits your pipeline. We don't make you parse the response twice.",
  },
  {
    title: 'Transparent pricing',
    body: '1 credit per native transcript, regardless of video length. No surprise overage charges.',
  },
  {
    title: 'Built for developers',
    body: 'Stripe-quality docs, predictable error envelope, rate-limit headers. Integrate in five minutes.',
  },
];

export default function HomePage() {
  return (
    <>
      <SiteNav />
      <main className="container mx-auto px-4 max-w-6xl">
        {/* Hero */}
        <section className="py-16 md:py-24 text-center">
          <p className="text-sm font-medium text-muted-foreground mb-4">
            YouTube → Transcript → JSON. In milliseconds.
          </p>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-balance">
            The cleanest YouTube transcript API on the market.
          </h1>
          <p className="mt-6 text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto text-balance">
            Send a YouTube URL, get back a transcript. With auto-detected languages,
            Whisper fallback, multiple output formats, and aggressive caching.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">Get a free API key</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/docs">Read the docs</Link>
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            100 free credits, no card required.
          </p>
        </section>

        {/* Code sample */}
        <section className="pb-16">
          <Card className="bg-zinc-950 text-zinc-100 border-zinc-800 overflow-hidden">
            <CardHeader className="border-b border-zinc-800">
              <CardTitle className="text-base font-medium text-zinc-200">
                Enqueue a job, poll for the transcript
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Tabs defaultValue="curl">
                <TabsList className="rounded-none bg-zinc-900 border-b border-zinc-800 w-full justify-start gap-1 px-2">
                  <TabsTrigger value="curl">curl</TabsTrigger>
                  <TabsTrigger value="node">Node.js</TabsTrigger>
                  <TabsTrigger value="python">Python</TabsTrigger>
                </TabsList>
                {(['curl', 'node', 'python'] as const).map((lang) => (
                  <TabsContent key={lang} value={lang} className="m-0">
                    <pre className="p-6 text-sm overflow-x-auto font-mono leading-relaxed">
                      <code>{SNIPPETS[lang]}</code>
                    </pre>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </section>

        {/* Features */}
        <section className="py-16">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-center mb-12">
            Everything you need to ship faster
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <CardHeader>
                  <CardTitle className="text-base">{f.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{f.body}</CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight mb-4">Ship it this afternoon.</h2>
          <p className="text-muted-foreground mb-6">
            Sign up, generate an API key, make your first call. The free tier is enough to prove it works.
          </p>
          <Button asChild size="lg">
            <Link href="/signup">Get your free API key</Link>
          </Button>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
