# Async Transcript Queue — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the dashboard so transcript requests are submitted to the async backend queue — the user submits and immediately moves on, sees one unified list of queued/processing/completed/failed entries with live status, and opens a completed transcript from its stored result.

**Architecture:** The `features/transcripts` module is rewritten against the new `/me/transcripts` async endpoints. React Query polls the list, detail, and batch endpoints on an interval while any row is still `queued`/`processing`, so status changes surface without a manual refresh. The transcripts list renders standalone request rows and collapsible batch groups. The viewer is keyed by request id and renders the request's stored `result`.

**Tech Stack:** Next.js 14 (App Router), React 18, TanStack Query v5, axios (`createApi` adapter), shadcn/ui, Tailwind, sonner.

**Spec:** `docs/superpowers/specs/2026-05-16-async-transcript-queue-design.md`
**Depends on:** `docs/superpowers/plans/2026-05-16-async-transcript-queue-backend.md` — the backend plan must be merged and running first; this plan calls its endpoints.

**Testing note:** the frontend has no automated test setup (no test script, no `*.test.tsx`). This plan verifies each task with `npm run type-check`, `npm run lint`, and explicit manual browser checks instead of TDD. Do not add a test framework.

---

## Backend contract this plan consumes

From the backend plan — the shapes the frontend types must mirror:

- **`TranscriptRequest`** (a `transcript_requests` row): `id`, `user_id`, `source`, `status` (`queued|processing|completed|failed|canceled`), `request` (`{ url, format, language?, native_only?, translate_to? }`), `video_id`, `title`, `channel`, `duration_seconds`, `thumbnail_url`, `bullmq_job_id`, `attempts`, `result` (`TranscriptResponse | null`), `credits_used`, `error_code`, `error_message`, `batch_id`, `batch_position`, `created_at`, `started_at`, `completed_at`.
- **`POST /me/transcripts`** body `{ url, format?, language?, native_only?, translate_to? }` → `202`/`200` + a `TranscriptRequest`.
- **`POST /me/transcripts/bulk`** body `{ playlist? | channel? | urls?, format?, language?, native_only?, translate_to?, limit? }` → `202` + `{ batch, requests }`.
- **`GET /me/transcripts`** `?limit&offset` → `{ items: TranscriptRequest[], total, limit, offset }`.
- **`GET /me/transcripts/:id`** → a `TranscriptRequest`.
- **`DELETE /me/transcripts/:id`** → the canceled `TranscriptRequest`.
- **`GET /me/transcripts/batches/:id`** → `{ batch, progress, requests }` where `progress` is `{ queued, processing, completed, failed, canceled }`.
- **`DELETE /me/transcripts/batches/:id`** → cancels every still-`queued` child; returns `{ batch, canceled, progress }`.

---

## File Structure

**Create:**
- `frontend/src/components/transcripts/RequestStatusBadge.tsx` — status pill.
- `frontend/src/components/transcripts/TranscriptRequestRow.tsx` — one list row.
- `frontend/src/components/transcripts/BatchGroup.tsx` — collapsible batch header + child rows.

**Modify:**
- `frontend/src/lib/api.ts` — add the new domain types; remove the dead synchronous `transcripts.fetch`/`fetchAsUser` surface.
- `frontend/src/features/transcripts/types.ts` — new request/batch types.
- `frontend/src/features/transcripts/transcripts.service.ts` — new endpoint adapters.
- `frontend/src/features/transcripts/transcripts.queries.ts` — new hooks.
- `frontend/src/features/transcripts/queryKeys.ts` — new keys.
- `frontend/src/features/transcripts/index.ts` — re-exports.
- `frontend/src/app/dashboard/transcripts/page.tsx` — list rewrite.
- `frontend/src/app/dashboard/transcripts/new/page.tsx` — non-blocking submit + bulk.
- `frontend/src/features/playground/PlaygroundClient.tsx` — async rework (Task 9).

**Move / replace:**
- `frontend/src/app/dashboard/transcripts/[videoId]/page.tsx` → `frontend/src/app/dashboard/transcripts/[id]/page.tsx` — viewer keyed by request id.
- `frontend/src/components/transcripts-history/HistoryRow.tsx` — superseded by `TranscriptRequestRow`; deleted in Task 4.

---

## Task 1: Domain types

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/transcripts/types.ts`

- [ ] **Step 1: Add the new domain types to `lib/api.ts`**

In `frontend/src/lib/api.ts`, in the `/* -------------------- Domain types -------------------- */` section, after the existing `TranscriptResponse` interface, add:

```ts
export type RequestStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface TranscriptRequestConfig {
  url: string;
  format: string;
  language?: string;
  native_only?: boolean;
  translate_to?: string;
}

/** A transcript_requests row — the unit of the async queue. */
export interface TranscriptRequest {
  id: string;
  source: 'api' | 'dashboard';
  status: RequestStatus;
  request: TranscriptRequestConfig;
  video_id: string | null;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  attempts: number;
  result: TranscriptResponse | null;
  credits_used: number | null;
  error_code: string | null;
  error_message: string | null;
  batch_id: string | null;
  batch_position: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface TranscriptBatch {
  id: string;
  kind: 'playlist' | 'channel' | 'videos';
  source_url: string | null;
  label: string | null;
  total: number;
  created_at: string;
}

export interface BatchProgress {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  canceled: number;
}

export interface RequestListResponse {
  items: TranscriptRequest[];
  total: number;
  limit: number;
  offset: number;
}

export interface BatchDetailResponse {
  batch: TranscriptBatch;
  progress: BatchProgress;
  requests: TranscriptRequest[];
}

export interface BatchCreateResponse {
  batch: TranscriptBatch;
  requests: TranscriptRequest[];
}
```

- [ ] **Step 2: Rewrite the feature types**

Overwrite `frontend/src/features/transcripts/types.ts` with:

```ts
import type {
  BatchCreateResponse,
  BatchDetailResponse,
  RequestListResponse,
  TranscriptRequest,
  TranscriptResponse,
} from '@/lib/api';

export interface CreateTranscriptInput {
  url: string;
  format?: string;
  language?: string;
  native_only?: boolean;
  translate_to?: string;
}

export interface CreateBatchInput {
  /** Exactly one of playlist / channel / urls. */
  playlist?: string;
  channel?: string;
  urls?: string[];
  format?: string;
  language?: string;
  native_only?: boolean;
  translate_to?: string;
  limit?: number;
}

export interface ListRequestsInput {
  limit?: number;
  offset?: number;
}

export type {
  BatchCreateResponse,
  BatchDetailResponse,
  RequestListResponse,
  TranscriptRequest,
  TranscriptResponse,
};
```

- [ ] **Step 3: Verify it typechecks**

Run from `frontend/`: `npm run type-check`
Expected: errors only in files that still reference the now-removed `HistoryItem`/`FetchTranscriptInput` — those are fixed in later tasks. No errors inside `lib/api.ts` or `features/transcripts/types.ts` themselves.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/transcripts/types.ts
git commit -m "feat(transcripts): add async queue domain types"
```

---

## Task 2: Service layer

**Files:**
- Modify: `frontend/src/features/transcripts/transcripts.service.ts`

- [ ] **Step 1: Rewrite the service**

Overwrite `frontend/src/features/transcripts/transcripts.service.ts` with:

```ts
import { apiClient } from '@/lib/http/client';
import { createApi } from '@/lib/http/createApi';
import { methodsEnums } from '@/lib/http/constants';
import type {
  BatchCreateResponse,
  BatchDetailResponse,
  CreateBatchInput,
  CreateTranscriptInput,
  ListRequestsInput,
  RequestListResponse,
  TranscriptRequest,
} from './types';

/** POST /me/transcripts — enqueue one request. */
export const createTranscriptRequest = createApi<
  CreateTranscriptInput,
  TranscriptRequest
>({
  queryFn: apiClient,
  request: (input) => ({
    url: '/me/transcripts',
    method: methodsEnums.POST,
    data: input,
  }),
});

/** POST /me/transcripts/bulk — enqueue a playlist/channel/url-list batch. */
export const createTranscriptBatch = createApi<
  CreateBatchInput,
  BatchCreateResponse
>({
  queryFn: apiClient,
  request: (input) => ({
    url: '/me/transcripts/bulk',
    method: methodsEnums.POST,
    data: input,
  }),
});

/** GET /me/transcripts — paginated list of the user's requests. */
export const listTranscriptRequests = createApi<
  ListRequestsInput,
  RequestListResponse
>({
  queryFn: apiClient,
  query: (input) => ({
    url: '/me/transcripts',
    method: methodsEnums.GET,
    params: { limit: input.limit, offset: input.offset },
  }),
});

/** GET /me/transcripts/:id — one request. */
export const getTranscriptRequest = createApi<string, TranscriptRequest>({
  queryFn: apiClient,
  query: (id) => ({
    url: `/me/transcripts/${id}`,
    method: methodsEnums.GET,
  }),
});

/** DELETE /me/transcripts/:id — cancel a queued request. */
export const cancelTranscriptRequest = createApi<string, TranscriptRequest>({
  queryFn: apiClient,
  request: (id) => ({
    url: `/me/transcripts/${id}`,
    method: methodsEnums.DELETE,
  }),
});

/** GET /me/transcripts/batches/:id — batch summary + entries. */
export const getTranscriptBatch = createApi<string, BatchDetailResponse>({
  queryFn: apiClient,
  query: (id) => ({
    url: `/me/transcripts/batches/${id}`,
    method: methodsEnums.GET,
  }),
});
```

- [ ] **Step 2: Verify it typechecks**

Run from `frontend/`: `npm run type-check`
Expected: no new errors inside `transcripts.service.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/transcripts/transcripts.service.ts
git commit -m "feat(transcripts): async queue service adapters"
```

---

## Task 3: Query keys and hooks

**Files:**
- Modify: `frontend/src/features/transcripts/queryKeys.ts`
- Modify: `frontend/src/features/transcripts/transcripts.queries.ts`
- Modify: `frontend/src/features/transcripts/index.ts`

- [ ] **Step 1: Rewrite the query keys**

Overwrite `frontend/src/features/transcripts/queryKeys.ts` with:

```ts
import type { ListRequestsInput } from './types';

export const transcriptsQueryKeys = {
  all: ['transcripts'] as const,
  list: (input: ListRequestsInput) =>
    [...transcriptsQueryKeys.all, 'list', input] as const,
  detail: (id: string) => [...transcriptsQueryKeys.all, 'detail', id] as const,
  batch: (id: string) => [...transcriptsQueryKeys.all, 'batch', id] as const,
};
```

- [ ] **Step 2: Rewrite the hooks**

Overwrite `frontend/src/features/transcripts/transcripts.queries.ts` with:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelTranscriptRequest,
  createTranscriptBatch,
  createTranscriptRequest,
  getTranscriptBatch,
  getTranscriptRequest,
  listTranscriptRequests,
} from './transcripts.service';
import { transcriptsQueryKeys } from './queryKeys';
import type {
  BatchCreateResponse,
  BatchDetailResponse,
  CreateBatchInput,
  CreateTranscriptInput,
  ListRequestsInput,
  RequestListResponse,
  TranscriptRequest,
} from './types';

/** A request is still moving while queued or processing. */
function isActive(status: TranscriptRequest['status']): boolean {
  return status === 'queued' || status === 'processing';
}

export function useTranscriptRequestsQuery(input: ListRequestsInput) {
  return useQuery<RequestListResponse, Error>({
    queryKey: transcriptsQueryKeys.list(input),
    queryFn: () => listTranscriptRequests(input),
    // Poll while any row is still queued/processing so the list advances
    // through queued → processing → done without a manual refresh.
    refetchInterval: (query) =>
      query.state.data?.items.some((r) => isActive(r.status)) ? 4000 : false,
  });
}

export function useTranscriptRequestQuery(id: string, enabled: boolean) {
  return useQuery<TranscriptRequest, Error>({
    queryKey: transcriptsQueryKeys.detail(id),
    queryFn: () => getTranscriptRequest(id),
    enabled,
    refetchInterval: (query) =>
      query.state.data && isActive(query.state.data.status) ? 5000 : false,
    meta: { suppressGlobalError: true },
  });
}

export function useTranscriptBatchQuery(id: string, enabled: boolean) {
  return useQuery<BatchDetailResponse, Error>({
    queryKey: transcriptsQueryKeys.batch(id),
    queryFn: () => getTranscriptBatch(id),
    enabled,
    refetchInterval: (query) => {
      const p = query.state.data?.progress;
      return p && p.queued + p.processing > 0 ? 6000 : false;
    },
  });
}

export function useCreateTranscriptMutation() {
  const qc = useQueryClient();
  return useMutation<TranscriptRequest, Error, CreateTranscriptInput>({
    mutationFn: createTranscriptRequest,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: transcriptsQueryKeys.all });
    },
    meta: { suppressGlobalError: true },
  });
}

export function useCreateBatchMutation() {
  const qc = useQueryClient();
  return useMutation<BatchCreateResponse, Error, CreateBatchInput>({
    mutationFn: createTranscriptBatch,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: transcriptsQueryKeys.all });
    },
    meta: { suppressGlobalError: true },
  });
}

export function useCancelTranscriptMutation() {
  const qc = useQueryClient();
  return useMutation<TranscriptRequest, Error, string>({
    mutationFn: cancelTranscriptRequest,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: transcriptsQueryKeys.all });
    },
    meta: { suppressGlobalError: true },
  });
}
```

- [ ] **Step 3: Rewrite the barrel export**

Overwrite `frontend/src/features/transcripts/index.ts` with:

```ts
export {
  useCancelTranscriptMutation,
  useCreateBatchMutation,
  useCreateTranscriptMutation,
  useTranscriptBatchQuery,
  useTranscriptRequestQuery,
  useTranscriptRequestsQuery,
} from './transcripts.queries';
export { transcriptsQueryKeys } from './queryKeys';
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/transcripts/queryKeys.ts frontend/src/features/transcripts/transcripts.queries.ts frontend/src/features/transcripts/index.ts
git commit -m "feat(transcripts): async queue query hooks"
```

---

## Task 4: Status badge and request row components

**Files:**
- Create: `frontend/src/components/transcripts/RequestStatusBadge.tsx`
- Create: `frontend/src/components/transcripts/TranscriptRequestRow.tsx`
- Delete: `frontend/src/components/transcripts-history/HistoryRow.tsx`

- [ ] **Step 1: Write the status badge**

Create `frontend/src/components/transcripts/RequestStatusBadge.tsx`:

```tsx
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
```

- [ ] **Step 2: Write the request row**

Create `frontend/src/components/transcripts/TranscriptRequestRow.tsx`:

```tsx
'use client';

import { memo } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RequestStatusBadge } from './RequestStatusBadge';
import { formatRelativeTime, formatTimecode } from '@/lib/format';
import type { TranscriptRequest } from '@/lib/api';

interface Props {
  request: TranscriptRequest;
  /** Cancel handler — only rendered for `queued` rows. */
  onCancel?: (id: string) => void;
  canceling?: boolean;
}

/**
 * One row in the unified transcripts list. A `completed` row links into the
 * viewer; non-completed rows show their status and (for `queued`) a cancel
 * action. Metadata renders as soon as the worker fills it in.
 */
export const TranscriptRequestRow = memo(function TranscriptRequestRow({
  request,
  onCancel,
  canceling,
}: Props) {
  const clickable = request.status === 'completed';
  const inner = (
    <Card
      className={
        clickable ? 'transition-colors group-hover:border-foreground/30' : ''
      }
    >
      <CardContent className="p-3 sm:p-4 flex gap-4 items-start">
        <div className="relative shrink-0 w-32 sm:w-40 aspect-video bg-muted rounded overflow-hidden">
          {request.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- YouTube thumbnail CDN; <Image> would force remotePatterns config
            <img
              src={request.thumbnail_url}
              alt=""
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">
              No preview
            </div>
          )}
          {request.duration_seconds ? (
            <span className="absolute bottom-1 right-1 rounded bg-black/80 text-white text-[10px] font-medium px-1 py-0.5 tabular-nums">
              {formatTimecode(request.duration_seconds)}
            </span>
          ) : null}
        </div>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold text-sm line-clamp-2">
              {request.title ?? (
                <span className="text-muted-foreground">
                  {request.request.url}
                </span>
              )}
            </h3>
            <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
              {formatRelativeTime(request.created_at)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {request.channel ?? '—'}
            {request.video_id ? (
              <>
                {' · '}
                <span className="font-mono">{request.video_id}</span>
              </>
            ) : null}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <RequestStatusBadge status={request.status} />
            {request.status === 'failed' && request.error_message && (
              <span className="text-[11px] text-destructive line-clamp-1">
                {request.error_message}
              </span>
            )}
            {request.status === 'processing' && (
              <span className="text-[11px] text-muted-foreground">
                Transcribing…
              </span>
            )}
            {request.status === 'queued' && (
              <span className="text-[11px] text-muted-foreground">
                Waiting in queue
              </span>
            )}
          </div>
        </div>

        {request.status === 'queued' && onCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={canceling}
            onClick={(e) => {
              e.preventDefault();
              onCancel(request.id);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </CardContent>
    </Card>
  );

  if (clickable) {
    return (
      <Link
        href={`/dashboard/transcripts/${request.id}`}
        className="block group"
      >
        {inner}
      </Link>
    );
  }
  return <div>{inner}</div>;
});
```

- [ ] **Step 3: Delete the superseded row**

```bash
git rm frontend/src/components/transcripts-history/HistoryRow.tsx
```

- [ ] **Step 4: Verify it typechecks**

Run from `frontend/`: `npm run type-check`
Expected: errors now only in `app/dashboard/transcripts/page.tsx` (still imports the deleted `HistoryRow`) — fixed in Task 6. Confirm `formatRelativeTime` and `formatTimecode` exist in `frontend/src/lib/format.ts`; they are used by the old `HistoryRow` so they do.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transcripts/
git commit -m "feat(transcripts): status badge and request row components"
```

---

## Task 5: Batch group component

**Files:**
- Create: `frontend/src/components/transcripts/BatchGroup.tsx`

- [ ] **Step 1: Write the batch group**

Create `frontend/src/components/transcripts/BatchGroup.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TranscriptRequestRow } from './TranscriptRequestRow';
import { useTranscriptBatchQuery } from '@/features/transcripts';
import type { TranscriptBatch } from '@/lib/api';

interface Props {
  batch: TranscriptBatch;
  /** Cancel handler passed through to each queued child row. */
  onCancel?: (id: string) => void;
  canceling?: boolean;
}

/**
 * A collapsible group for one bulk batch. The header shows the playlist /
 * channel label and derived progress; expanding fetches and lists the
 * batch's child requests.
 */
export function BatchGroup({ batch, onCancel, canceling }: Props) {
  const [open, setOpen] = useState(false);
  const batchQuery = useTranscriptBatchQuery(batch.id, open);
  const progress = batchQuery.data?.progress;

  const summary = progress
    ? `${progress.completed}/${batch.total} done` +
      (progress.failed ? ` · ${progress.failed} failed` : '')
    : `${batch.total} videos`;

  return (
    <Card>
      <CardContent className="p-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 p-3 sm:p-4 text-left hover:bg-muted/40"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">
              {batch.kind === 'playlist'
                ? 'Playlist'
                : batch.kind === 'channel'
                  ? 'Channel'
                  : 'Video list'}
              {batch.label ? `: ${batch.label}` : ''}
            </p>
            <p className="text-xs text-muted-foreground">{summary}</p>
          </div>
        </button>

        {open && (
          <div className="border-t p-3 sm:p-4 space-y-2">
            {batchQuery.isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {batchQuery.data?.requests.map((r) => (
              <TranscriptRequestRow
                key={r.id}
                request={r}
                onCancel={onCancel}
                canceling={canceling}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run from `frontend/`: `npm run type-check`
Expected: no new errors in `BatchGroup.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/transcripts/BatchGroup.tsx
git commit -m "feat(transcripts): collapsible batch group component"
```

---

## Task 6: Transcripts list page

**Files:**
- Modify: `frontend/src/app/dashboard/transcripts/page.tsx`

- [ ] **Step 1: Rewrite the list page**

Overwrite `frontend/src/app/dashboard/transcripts/page.tsx` with:

```tsx
'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import { getApiErrorMessage } from '@/lib/apiError';
import { TranscriptRequestRow } from '@/components/transcripts/TranscriptRequestRow';
import { BatchGroup } from '@/components/transcripts/BatchGroup';
import {
  useCancelTranscriptMutation,
  useTranscriptRequestsQuery,
} from '@/features/transcripts';
import type { TranscriptBatch, TranscriptRequest } from '@/lib/api';

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

/**
 * Unified transcripts list — standalone request rows plus collapsible batch
 * groups, newest first. React Query polls while any row is queued/processing
 * so statuses advance without a manual refresh; the Refresh button forces an
 * immediate re-fetch.
 */
export default function TranscriptsPage() {
  const [offset, setOffset] = useState(0);

  const listQuery = useTranscriptRequestsQuery({ limit: PAGE_SIZE, offset });
  const cancelMutation = useCancelTranscriptMutation();

  const items = useMemo(
    () => listQuery.data?.items ?? [],
    [listQuery.data?.items],
  );
  const total = listQuery.data?.total ?? 0;
  const loading = listQuery.isLoading;

  // Build the display order: each standalone request is its own entry; the
  // rows of a batch collapse into a single batch entry positioned at the
  // batch's newest row.
  const entries = useMemo(() => {
    const result: Array<
      | { kind: 'request'; request: TranscriptRequest }
      | { kind: 'batch'; batch: TranscriptBatch }
    > = [];
    const seenBatches = new Set<string>();
    for (const r of items) {
      if (!r.batch_id) {
        result.push({ kind: 'request', request: r });
        continue;
      }
      if (seenBatches.has(r.batch_id)) continue;
      seenBatches.add(r.batch_id);
      // The batch row carries enough to render the header; BatchGroup
      // fetches full detail (label, progress) on expand.
      result.push({
        kind: 'batch',
        batch: {
          id: r.batch_id,
          kind: 'videos',
          source_url: null,
          label: null,
          total: 0,
          created_at: r.created_at,
        },
      });
    }
    return result;
  }, [items]);

  function handleCancel(id: string) {
    cancelMutation.mutate(id, {
      onSuccess: () => toast.success('Request canceled'),
      onError: (err) =>
        toast.error(getApiErrorMessage(err, 'Could not cancel request')),
    });
  }

  const hasResults = entries.length > 0;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Transcripts</h1>
          <p className="text-muted-foreground text-sm">
            Every transcript you&apos;ve requested. New requests run in the
            background — you can queue more right away.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void listQuery.refetch()}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
          <Button asChild>
            <Link href="/dashboard/transcripts/new">
              <Plus className="h-4 w-4 mr-1.5" />
              New transcript
            </Link>
          </Button>
        </div>
      </div>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {!loading && !hasResults && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No transcripts yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Request your first transcript from a YouTube URL — it&apos;ll
              appear here and process in the background.
            </p>
            <Button asChild>
              <Link href="/dashboard/transcripts/new">
                <Plus className="h-4 w-4 mr-1.5" />
                New transcript
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {hasResults && (
        <div className="space-y-2">
          {entries.map((entry) =>
            entry.kind === 'request' ? (
              <TranscriptRequestRow
                key={entry.request.id}
                request={entry.request}
                onCancel={handleCancel}
                canceling={cancelMutation.isPending}
              />
            ) : (
              <BatchGroup
                key={entry.batch.id}
                batch={entry.batch}
                onCancel={handleCancel}
                canceling={cancelMutation.isPending}
              />
            ),
          )}
        </div>
      )}

      {hasResults && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm pt-2">
          <span className="text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + items.length, total)} of{' '}
            {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Note: search was dropped — the new list endpoint has no `q` param. If search is wanted later it is a separate backend change.

- [ ] **Step 2: Verify it typechecks and lints**

Run from `frontend/`: `npm run type-check && npm run lint`
Expected: no errors in `transcripts/page.tsx`.

- [ ] **Step 3: Manual verification**

With the backend running and logged in, open `/dashboard/transcripts`. Expected: the list renders (empty state if no requests). Leave it open during Task 7's manual check to confirm a new request appears via polling.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/dashboard/transcripts/page.tsx
git commit -m "feat(transcripts): unified live queue list page"
```

---

## Task 7: New transcript form — non-blocking submit + bulk

**Files:**
- Modify: `frontend/src/app/dashboard/transcripts/new/page.tsx`

- [ ] **Step 1: Rewrite the form**

Overwrite `frontend/src/app/dashboard/transcripts/new/page.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { TARGET_LANGUAGE_OPTIONS } from '@/lib/languages';
import { extractVideoId } from '@/lib/youtube-url';
import { getApiErrorMessage } from '@/lib/apiError';
import {
  useCreateBatchMutation,
  useCreateTranscriptMutation,
} from '@/features/transcripts';

/** True for a playlist or channel URL — routed to the bulk endpoint. */
function isBulkUrl(input: string): boolean {
  return (
    /[?&]list=/.test(input) ||
    /youtube\.com\/(@|channel\/|c\/|user\/)/.test(input)
  );
}

/**
 * Submit a transcript request to the async queue. Submitting does not block
 * or navigate away — the field clears so the user can immediately queue the
 * next URL. Playlist/channel URLs are sent to the bulk endpoint.
 */
export default function NewTranscriptPage() {
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState('');
  const [translateTo, setTranslateTo] = useState('');

  const createMutation = useCreateTranscriptMutation();
  const batchMutation = useCreateBatchMutation();
  const submitting = createMutation.isPending || batchMutation.isPending;

  function sharedConfig() {
    return {
      language: language.trim() || undefined,
      translate_to:
        translateTo.trim() && translateTo !== 'none'
          ? translateTo.trim()
          : undefined,
    };
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    if (isBulkUrl(trimmed)) {
      const isPlaylist = /[?&]list=/.test(trimmed);
      batchMutation.mutate(
        {
          ...(isPlaylist ? { playlist: trimmed } : { channel: trimmed }),
          ...sharedConfig(),
        },
        {
          onSuccess: (res) => {
            toast.success(
              `Queued ${res.requests.length} videos from the ${
                isPlaylist ? 'playlist' : 'channel'
              }.`,
            );
            setUrl('');
          },
          onError: (err) =>
            toast.error(getApiErrorMessage(err, 'Could not queue the batch')),
        },
      );
      return;
    }

    if (!extractVideoId(trimmed)) {
      toast.error("That doesn't look like a YouTube URL or video id.");
      return;
    }
    createMutation.mutate(
      { url: trimmed, ...sharedConfig() },
      {
        onSuccess: () => {
          toast.success('Added to the queue.');
          setUrl('');
        },
        onError: (err) =>
          toast.error(getApiErrorMessage(err, 'Could not queue the request')),
      },
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href="/dashboard/transcripts">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to transcripts
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">New transcript</h1>
        <p className="text-muted-foreground text-sm">
          Paste a YouTube video, playlist, or channel URL. Requests run in the
          background — submit as many as you like; track them on the
          transcripts page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Queue a transcript</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="url">YouTube video, playlist, or channel URL</Label>
              <Input
                id="url"
                type="text"
                required
                placeholder="https://youtu.be/dQw4w9WgXcQ"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <div className="space-y-2">
                <Label htmlFor="language">Source language</Label>
                <Input
                  id="language"
                  placeholder="auto"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="translate-to">Translate to</Label>
                <SearchableSelect
                  id="translate-to"
                  value={translateTo || 'none'}
                  onValueChange={(v) => setTranslateTo(v === 'none' ? '' : v)}
                  options={TARGET_LANGUAGE_OPTIONS.map((l) => ({
                    value: l.code,
                    label: l.label,
                  }))}
                  searchPlaceholder="Search languages…"
                />
              </div>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Queuing…' : 'Add to queue'}
              </Button>
            </div>
          </form>
          <p className="text-xs text-muted-foreground mt-3">
            Costs 1 credit per fresh transcript (cached videos are free).
            Translation costs <strong>+1 credit</strong> per video.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks and lints**

Run from `frontend/`: `npm run type-check && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual verification**

With `/dashboard/transcripts` open in another tab: on `/dashboard/transcripts/new`, paste a video URL and submit. Expected: toast "Added to the queue", the input clears, and within a few seconds a `queued` row appears in the other tab as React Query polls — no manual refresh needed. Submit a second URL immediately — both queue independently. Paste a playlist URL — a batch group appears.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/dashboard/transcripts/new/page.tsx
git commit -m "feat(transcripts): non-blocking submit form with playlist/channel bulk"
```

---

## Task 8: Viewer page — keyed by request id

**Files:**
- Create: `frontend/src/app/dashboard/transcripts/[id]/page.tsx`
- Delete: `frontend/src/app/dashboard/transcripts/[videoId]/page.tsx`

- [ ] **Step 1: Create the new viewer route**

Create `frontend/src/app/dashboard/transcripts/[id]/page.tsx`:

```tsx
'use client';

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { getApiErrorMessage } from '@/lib/apiError';
import { TranscriptViewer } from '@/features/transcript-viewer';
import {
  useCreateTranscriptMutation,
  useTranscriptRequestQuery,
} from '@/features/transcripts';

/**
 * Viewer for one transcript request. While the request is queued/processing
 * it shows a live status card; once `completed` it renders the stored
 * `result`. Picking a new translation target queues a fresh request and
 * navigates to it.
 */
export default function TranscriptViewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const requestQuery = useTranscriptRequestQuery(id, !!id);
  const createMutation = useCreateTranscriptMutation();

  const request = requestQuery.data;
  const loading = requestQuery.isLoading;
  const errorMsg = requestQuery.error
    ? getApiErrorMessage(requestQuery.error, 'Could not load this request')
    : null;

  function onTranslateTargetChange(target: string | null) {
    if (!request) return;
    createMutation.mutate(
      {
        url: request.request.url,
        language: request.request.language,
        translate_to: target ?? undefined,
      },
      {
        onSuccess: (next) => {
          router.push(`/dashboard/transcripts/${next.id}`);
        },
        onError: (err) =>
          toast.error(getApiErrorMessage(err, 'Could not queue translation')),
      },
    );
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/transcripts">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to transcripts
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/transcripts/new">New transcript</Link>
        </Button>
      </div>

      {loading && !request && (
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6">
              <Skeleton className="aspect-video" />
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {errorMsg && !loading && !request && (
        <Card>
          <CardContent className="p-6">
            <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-medium mb-1">Could not load this request</p>
              <p>{errorMsg}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {request &&
        (request.status === 'queued' || request.status === 'processing') && (
          <Card>
            <CardContent className="p-8 text-center space-y-2">
              <p className="font-semibold">
                {request.status === 'queued'
                  ? 'Waiting in the queue…'
                  : 'Transcribing…'}
              </p>
              <p className="text-sm text-muted-foreground">
                {request.title ?? request.request.url}
              </p>
              <p className="text-xs text-muted-foreground">
                This page updates automatically when it&apos;s ready.
              </p>
            </CardContent>
          </Card>
        )}

      {request && request.status === 'failed' && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-medium mb-1">This transcript failed</p>
              <p>{request.error_message ?? 'Unknown error.'}</p>
            </div>
            <Button
              variant="outline"
              disabled={createMutation.isPending}
              onClick={() =>
                createMutation.mutate(request.request, {
                  onSuccess: (next) =>
                    router.push(`/dashboard/transcripts/${next.id}`),
                  onError: (err) =>
                    toast.error(getApiErrorMessage(err, 'Retry failed')),
                })
              }
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {request && request.status === 'canceled' && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            This request was canceled.
          </CardContent>
        </Card>
      )}

      {request && request.status === 'completed' && request.result && (
        <TranscriptViewer
          data={request.result}
          onTranslateTargetChange={onTranslateTargetChange}
          isRefetching={createMutation.isPending}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Delete the old route**

```bash
git rm 'frontend/src/app/dashboard/transcripts/[videoId]/page.tsx'
```

If the `[videoId]` directory is now empty, remove it: `rmdir 'frontend/src/app/dashboard/transcripts/[videoId]'`.

- [ ] **Step 3: Verify it typechecks and lints**

Run from `frontend/`: `npm run type-check && npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Queue a request, wait for it to reach `completed` in the list, click the row. Expected: navigates to `/dashboard/transcripts/<id>`; if still processing it shows the live status card and flips to the rendered transcript automatically; the viewer's translate dropdown queues a new request and navigates to it.

- [ ] **Step 5: Commit**

```bash
git add 'frontend/src/app/dashboard/transcripts/[id]/page.tsx'
git commit -m "feat(transcripts): request-id viewer with live status and retry"
```

---

## Task 9: Playground — async rework

**Files:**
- Modify: `frontend/src/features/playground/PlaygroundClient.tsx`

The playground's playlist/channel tabs and synchronous transcript fetch are dead — the backend removed `GET /v1/transcript`, `/v1/playlist/transcripts`, and `/v1/channel/transcripts`. Rework the playground into a single async-queue demo.

- [ ] **Step 1: Replace the Videos-tab flow and drop the bulk tabs**

In `frontend/src/features/playground/PlaygroundClient.tsx`:

- Remove the `tab` state and the `Tabs`/`TabsList`/`TabsContent` for `playlist` and `channel`; keep only the multi-URL textarea (`videosText` / `videoList`). Remove `playlistInput`, `channelInput`, `channelQuery`, `channelMode`, `browseLimit` state and their inputs.
- Remove the imports and uses of `useFetchTranscriptAsUserMutation`, `useFetchTranscriptWithBearerMutation`, `usePlaylistTranscriptsMutation`, `useChannelTranscriptsMutation`, `BulkTranscriptItem`, `ChannelTranscriptsMode`, `fetchBulkTranscripts`, and `bulkItemToEntry`.
- Replace `onSubmit` so that, for each parsed video URL, it calls the new async API and then polls until the request is `completed`/`failed`:

```tsx
import { api } from '@/lib/api';
import type { TranscriptRequest } from '@/lib/api';

// Enqueue one request via the API key, then poll GET /v1/transcript/:id.
async function runOne(
  bearer: string,
  body: Record<string, unknown>,
): Promise<TranscriptRequest> {
  const created = await api<TranscriptRequest>('/v1/transcript', {
    method: 'POST',
    body,
    bearer,
  });
  let current = created;
  while (current.status === 'queued' || current.status === 'processing') {
    await new Promise((r) => setTimeout(r, 2500));
    current = await api<TranscriptRequest>(`/v1/transcript/${created.id}`, {
      bearer,
    });
  }
  return current;
}
```

In the submit loop, push a `BulkResultEntry`: on `completed` use `{ url, ok: true, data: current.result! }`; on `failed`/`canceled` use `{ url, ok: false, error: current.error_message ?? 'Request failed' }`. The playground requires a plaintext API key (`selectedPlaintext`); if absent, `toast.error` and abort — there is no cookie-auth fallback for the public API.

- Update the curl preview: `buildCurlPreview` in `frontend/src/features/playground/utils.ts` must emit `curl -X POST .../v1/transcript -d '{...}'` for the video mode and drop the `playlist`/`channel` modes. Adjust `utils.ts` and the `mode` union in its options type accordingly.

- [ ] **Step 2: Verify it typechecks and lints**

Run from `frontend/`: `npm run type-check && npm run lint`
Expected: no errors. Fix any remaining references to removed symbols (`features/youtube` bulk hooks may now be unused — leave that module in place; it still backs the browse endpoints).

- [ ] **Step 3: Manual verification**

Open `/dashboard/playground`, pick a stashed API key, paste one or two video URLs, submit. Expected: the button shows progress, each result resolves to a rendered transcript or an error note; the curl preview shows a `POST /v1/transcript` command.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/playground/
git commit -m "feat(playground): async enqueue-and-poll against /v1/transcript"
```

---

## Task 10: Clean up the dead synchronous API surface

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Remove the dead transcript helpers**

In `frontend/src/lib/api.ts`, delete the `FetchTranscriptInput` interface, the `transcriptQuery` helper, the `HistoryItem` / `HistoryResponse` interfaces, and the `transcripts` export object (`fetch` / `fetchAsUser` / `listMine`) — all target removed endpoints. Keep `TranscriptResponse`, `TranscriptSegment`, and the new queue types from Task 1.

- [ ] **Step 2: Verify nothing else imports them**

Run from `frontend/`: `grep -rn "HistoryItem\|HistoryResponse\|FetchTranscriptInput\|from '@/lib/api'" src | grep -i "history\|FetchTranscript"`
Expected: no matches. If any file still imports a removed symbol, update it (the transcripts feature module was rewritten in Tasks 1–3; `features/transcripts/types.ts` no longer imports these).

- [ ] **Step 3: Verify it typechecks, lints, and builds**

Run from `frontend/`: `npm run type-check && npm run lint && npm run build`
Expected: a clean production build.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "refactor(transcripts): drop dead synchronous transcript API surface"
```

---

## Task 11: End-to-end verification

No code changes — verify the whole frontend against the running backend.

- [ ] **Step 1: Build passes**

Run from `frontend/`: `npm run type-check && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 2: Submit-and-move-on**

On `/dashboard/transcripts/new`, submit a video URL. Expected: toast, field clears, no navigation. Submit two more immediately. Open `/dashboard/transcripts` — all three rows appear, each advancing `queued → processing → completed` live (no manual refresh).

- [ ] **Step 3: Completed transcript opens**

Click a `completed` row. Expected: the viewer renders the transcript; the translate dropdown queues a new request and navigates to it.

- [ ] **Step 4: Cancel**

Submit a request and immediately click its row's cancel (X) while `queued`. Expected: toast "Request canceled"; the row shows `Canceled`.

- [ ] **Step 5: Failure + retry**

Submit a URL that will fail (e.g. a video with no captions on a free plan). Expected: the row reaches `Failed` with the error; opening it offers Retry, which queues a fresh request.

- [ ] **Step 6: Bulk batch**

Submit a small playlist URL. Expected: a batch group appears; expanding it lists child rows with derived progress that converges to "done".

- [ ] **Step 7: Polling resilience**

With `/dashboard/transcripts` open, stop and restart the backend. Expected: the page keeps working — a failed poll surfaces gracefully and, once the backend is back, the next interval poll refreshes active rows automatically.

- [ ] **Step 8: Final commit (if verification fixes were needed)**

```bash
git add -A
git commit -m "test(transcripts): frontend end-to-end verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** non-blocking submit (Task 7), unified list with status (Tasks 4, 6), batch grouping (Tasks 5, 6, 7), polling live updates (Tasks 3, 6, 8), viewer from stored `result` (Task 8), cancel queued-only (Tasks 4, 6), retry failed (Task 8), API consumer flow — playground loops `POST /v1/transcript` (Task 9). All user-facing spec items map to a task.
- **Type consistency:** `TranscriptRequest` / `TranscriptBatch` / `BatchProgress` / `RequestStatus` are defined once in `lib/api.ts` (Task 1) and imported everywhere; hook names (`useTranscriptRequestsQuery`, `useTranscriptRequestQuery`, `useTranscriptBatchQuery`, `useCreateTranscriptMutation`, `useCreateBatchMutation`, `useCancelTranscriptMutation`) match between `transcripts.queries.ts`, `index.ts`, and all page consumers.
- **No test framework added** — the frontend has none; verification is type-check + lint + build + manual, as stated up front.
- **Known follow-ups (out of scope):** transcript-list search (the new list endpoint has no `q` param); the `features/youtube` browse module is left intact since the discovery endpoints still exist.
