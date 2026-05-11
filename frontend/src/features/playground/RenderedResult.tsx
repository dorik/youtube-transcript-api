import type { TranscriptResponse, TranscriptSegment } from '@/lib/api';
import { formatTimecode } from '@/lib/format';

/**
 * Render one successful response. JSON format gets a nice segment table;
 * raw text/SRT/VTT just dumps the body in a `<pre>`.
 */
export function RenderedResult({
  data,
  showTimestamps,
}: {
  data: TranscriptResponse;
  showTimestamps: boolean;
}) {
  const isJsonFormat = data.format === 'json';

  if (!isJsonFormat || !data.segments) {
    return (
      <pre className="bg-zinc-950 text-zinc-100 rounded-md p-4 text-xs overflow-auto max-h-[500px] font-mono leading-relaxed">
        <code>
          {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
        </code>
      </pre>
    );
  }

  return (
    <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
      <div className="text-sm">
        <p className="font-semibold truncate">{data.title}</p>
        <p className="text-xs text-muted-foreground">
          {data.channel} · {data.language} · {data.segments.length} segments · credits used:{' '}
          {data.credits_used}
        </p>
      </div>
      <div className="border rounded-md divide-y bg-background">
        {data.segments.map((seg: TranscriptSegment) => (
          <div key={seg.start} className="flex gap-3 px-3 py-2 text-sm">
            {showTimestamps && (
              <span className="font-mono text-xs text-muted-foreground tabular-nums shrink-0 mt-0.5">
                {formatTimecode(seg.start)}
              </span>
            )}
            <span>{seg.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
