import { Badge } from '@/components/ui/badge';
import type { RequestStatus } from '@/lib/api';

const CONFIG: Record<
  RequestStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  queued: { label: 'Queued', variant: 'outline' },
  processing: { label: 'Processing', variant: 'secondary' },
  completed: { label: 'Done', variant: 'default' },
  failed: { label: 'Failed', variant: 'destructive' },
  canceled: { label: 'Canceled', variant: 'outline' },
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const { label, variant } = CONFIG[status];
  return (
    <Badge variant={variant} className="text-[10px]">
      {label}
    </Badge>
  );
}
