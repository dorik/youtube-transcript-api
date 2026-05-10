# Frontend Migration to `frontend/CLAUDE.md`

> Concrete, phased plan to bring `frontend/` in line with the conventions in [`frontend/CLAUDE.md`](../../frontend/CLAUDE.md).
> All findings below come from an audit run on the current `main` (commit `91550ac`).

---

## TL;DR

The codebase is in **good shape on the big things** — zero `any`, no direct `fetch()` outside `api.ts`, no `dangerouslySetInnerHTML`, no `document.getElementById`. What's missing is **scaffolding** (error boundaries, helpers) and **two oversized routes** (`playground/page.tsx` at 640 lines, `transcript-viewer.tsx` at 545).

Five phased PRs, ~12-16 hours total. Each phase is independently shippable.

| Phase | Scope | Risk | Effort |
|-------|-------|------|--------|
| 0. Infrastructure | helpers, error boundaries, scripts | none | 1-2h |
| 1. Quality fixes | apiError consolidation, console removal, eslint-disable reasons | low | 2-3h |
| 2. Hot file splits | playground + transcript-viewer + transcripts list | medium | 5-7h |
| 3. Performance | recharts dynamic import, list memoization | low | 1-2h |
| 4. Folder hygiene | feature folders + api.ts split | low | 2-3h |

---

## Audit findings (the input to this plan)

### ✅ Already clean
- Zero `any` in `src/`
- No `fetch()` outside [`src/lib/api.ts`](../../frontend/src/lib/api.ts)
- No `dangerouslySetInnerHTML`
- No `document.getElementById` / `querySelector`
- No icon-only buttons missing `aria-label` (sample audit)
- No derived-state-from-props pattern detected

### ❌ Concrete violations

**Missing infrastructure** (referenced by CLAUDE.md, doesn't exist yet):
- No `src/lib/apiError.ts` → 10 inline `err instanceof ApiError ? err.message : "…"` sites
- No `src/lib/constants.ts` → magic numbers in 2 places
- No `src/lib/openTrustedUrl.ts` → currently 0 sites need it, but the sanitizer story exists in CLAUDE.md
- No `src/app/global-error.tsx`
- No per-route `error.tsx` anywhere (12 routes affected)
- No `npm run type-check` script in `package.json`

**Direct env reads outside api.ts**:
- [`src/app/playground/page.tsx:637`](../../frontend/src/app/playground/page.tsx) — `process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'`

**`window.location.href`** (3 sites):
- [`src/app/signup/page.tsx:45`](../../frontend/src/app/signup/page.tsx) — post-signup redirect; **probably should be `router.push`**
- [`src/app/dashboard/billing/page.tsx:77,81`](../../frontend/src/app/dashboard/billing/page.tsx) — Stripe checkout redirect; **acceptable exception, needs comment**
- [`src/lib/youtube-player.ts:98`](../../frontend/src/lib/youtube-player.ts) — `window.location.origin` for YouTube IFrame postMessage; **acceptable, not navigation**

**`console.*` in production code** (2 real sites):
- [`src/components/dashboard/transcript-viewer.tsx:146`](../../frontend/src/components/dashboard/transcript-viewer.tsx) — `console.error` on YouTube mount fail (already wrapped in eslint-disable; replace with toast or guarded debug)
- [`src/components/dashboard/transcript-viewer.tsx:230`](../../frontend/src/components/dashboard/transcript-viewer.tsx) — `console.error` on export fail (toast already shown nearby; remove)

(Two `console.log` in [`src/app/page.tsx:20`](../../frontend/src/app/page.tsx) and [`src/app/docs/page.tsx:20`](../../frontend/src/app/docs/page.tsx) are inside marketing/docs code-example template strings — **not real violations**.)

**`eslint-disable` without `-- reason`** (5 sites):
- `src/app/dashboard/transcripts/page.tsx:185`
- `src/app/dashboard/layout.tsx:55`
- `src/app/dashboard/billing/page.tsx:49`
- `src/components/dashboard/transcript-viewer.tsx:145`
- `src/components/dashboard/transcript-viewer.tsx:229`

**Index as key in dynamic lists** (2 real, rest are skeleton arrays which are acceptable per §14.3):
- [`src/app/playground/page.tsx:532`](../../frontend/src/app/playground/page.tsx) — needs investigation (might be tab list)
- [`src/app/playground/page.tsx:593`](../../frontend/src/app/playground/page.tsx) — same
- [`src/components/dashboard/transcript-viewer.tsx:436`](../../frontend/src/components/dashboard/transcript-viewer.tsx) — segment list (segments **have** a stable id from `start` time, this is wrong)
- [`src/components/dashboard/subtitle-overlay.tsx:152`](../../frontend/src/components/dashboard/subtitle-overlay.tsx) — needs investigation

**Files exceeding soft complexity targets**:

| File | Lines | Target | useState | useEffect |
|------|-------|--------|----------|-----------|
| `src/app/playground/page.tsx` | **640** | 250 | **15** | — |
| `src/components/dashboard/transcript-viewer.tsx` | **545** | 250 | **8** | **5** |
| `src/lib/api.ts` | 303 | 200 (split target) | — | — |
| `src/app/dashboard/transcripts/page.tsx` | **303** | 250 | 7 | — |
| `src/components/dashboard/subtitle-settings-popover.tsx` | **265** | 250 | — | — |
| `src/app/docs/page.tsx` | 250 | 250 | — | — |
| `src/app/dashboard/api-keys/page.tsx` | 231 | 250 | 7 | — |

**Performance**:
- [`src/app/dashboard/usage/page.tsx`](../../frontend/src/app/dashboard/usage/page.tsx) imports `recharts` directly — should use `next/dynamic` per §13.2
- Segment list in transcript-viewer renders inside `.map()` without `React.memo` — at 30+ segments per typical video this matters

**Magic numbers**:
- `setTimeout(..., 250)` debounce in transcripts list
- `setTimeout(..., 1000)` for `URL.revokeObjectURL` in transcript-viewer

---

## Phase 0 — Infrastructure (1-2 hours, no behavior change)

**Goal:** make the rest of the migration mechanical.

### 0.1 Add `npm run type-check` script

Edit `frontend/package.json`:

```diff
   "scripts": {
     "dev": "next dev",
     "build": "next build",
     "start": "next start",
+    "type-check": "tsc --noEmit",
     "lint": "next lint"
   },
```

### 0.2 Create `src/lib/apiError.ts`

```typescript
import { ApiError } from "./api";

/**
 * Single source of truth for surfacing API errors as user-readable strings.
 * Use everywhere instead of inline `err instanceof ApiError ? err.message : ...`.
 */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}
```

### 0.3 Create `src/lib/constants.ts`

```typescript
/** Debounce for in-app search inputs (ms). */
export const SEARCH_DEBOUNCE_MS = 250;

/** How long to keep a Blob URL alive after triggering a download (ms). */
export const BLOB_URL_TTL_MS = 1000;

/** Default page size for paginated dashboard tables. */
export const DEFAULT_PAGE_SIZE = 25;
```

### 0.4 Add `src/app/global-error.tsx`

App Router root error boundary — catches anything that escapes per-route boundaries:

```typescript
"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console -- dev-only diagnostic
      console.error("Uncaught error", error);
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-4">
            <h1 className="text-2xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              The app hit an unexpected error. Try again, or go back home.
            </p>
            <div className="flex gap-2 justify-center">
              <Button onClick={reset}>Try again</Button>
              <Button asChild variant="outline">
                <a href="/">Go home</a>
              </Button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
```

### 0.5 Add `src/app/dashboard/error.tsx`

Workspace-level boundary that doesn't blow up the marketing site:

```typescript
"use client";

import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6 max-w-md">
      <h2 className="text-lg font-semibold mb-2">Could not load this page</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {error.message || "Something unexpected happened."}
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
```

### 0.6 (Optional, but recommended) Stricter ESLint

Add to `.eslintrc` rules:

```json
{
  "rules": {
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "react-hooks/exhaustive-deps": "warn"
  }
}
```

(Don't add `eslint-comments/require-description` yet — fold that into Phase 1.)

**Deliverable:** PR titled `chore(frontend): scaffold error boundaries + shared helpers`. Zero functional change. CI green.

---

## Phase 1 — Quality fixes (2-3 hours, low risk)

**Goal:** apply the helpers from Phase 0 across existing call sites.

### 1.1 Migrate `err instanceof ApiError` → `getApiErrorMessage`

**10 sites** (search results from audit):

```
src/app/signup/page.tsx:54
src/app/playground/page.tsx:159
src/app/dashboard/transcripts/page.tsx:60,80
src/app/dashboard/transcripts/[videoId]/page.tsx:51
src/app/dashboard/api-keys/page.tsx:38,68,84
src/app/login/page.tsx:43
src/app/dashboard/billing/page.tsx:46
```

Find/replace pattern:

```diff
- toast.error(err instanceof ApiError ? err.message : "Could not load history");
+ toast.error(getApiErrorMessage(err, "Could not load history"));
```

Add `import { getApiErrorMessage } from "@/lib/apiError";` to each file. Remove unused `ApiError` imports where they're now dead.

### 1.2 Remove production `console.error`

**[`transcript-viewer.tsx:145-146`](../../frontend/src/components/dashboard/transcript-viewer.tsx)** (YouTube mount fail):
```diff
- // eslint-disable-next-line no-console
- console.error("YouTube player failed to mount", err);
+ if (process.env.NODE_ENV !== "production") {
+   // eslint-disable-next-line no-console -- dev-only diagnostic; user already sees fallback UI
+   console.error("YouTube player failed to mount", err);
+ }
```

**[`transcript-viewer.tsx:229-230`](../../frontend/src/components/dashboard/transcript-viewer.tsx)** (export fail): toast is already shown via `getApiErrorMessage` after this line — the `console.error` is redundant. **Delete it** along with the eslint-disable.

### 1.3 Add reasons to remaining `eslint-disable`

**`src/app/dashboard/transcripts/page.tsx:185`** — `<img>` instead of `next/image`:
```diff
- {/* eslint-disable-next-line @next/next/no-img-element */}
+ {/* eslint-disable-next-line @next/next/no-img-element -- YouTube CDN doesn't support next/image loaders */}
```

**`src/app/dashboard/layout.tsx:55`** — exhaustive-deps on auth bootstrap:
```diff
- // eslint-disable-next-line react-hooks/exhaustive-deps
+ // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; router/router-events handled by separate effect
```

**`src/app/dashboard/billing/page.tsx:49`** — same pattern:
```diff
- // eslint-disable-next-line react-hooks/exhaustive-deps
+ // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only refetch when search params change
```

(Read each file to confirm the actual reason before merging — do not paste these placeholders blindly.)

### 1.4 Move `window.location.href` decisions

**`src/app/signup/page.tsx:45`** — currently does full-document redirect after signup. Should this be SPA navigation? Read the code first. If the redirect target is in-app, switch to `router.push(url)`. If it's an OAuth handoff to a third party, keep `window.location.href` and add a comment.

**`src/app/dashboard/billing/page.tsx:77,81`** — Stripe checkout. Keep, but add comment:
```diff
- window.location.href = url; // Stripe redirect
+ // Full-document redirect — Stripe checkout requires it
+ window.location.href = url;
```

**`src/lib/youtube-player.ts:98`** — `window.location.origin`, not navigation. **No change needed.**

### 1.5 Migrate magic numbers

**`src/app/dashboard/transcripts/page.tsx:35`**:
```diff
- const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
+ const t = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
```

**`src/components/dashboard/transcript-viewer.tsx:225`**:
```diff
- setTimeout(() => URL.revokeObjectURL(url), 1000);
+ setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
```

### 1.6 Fix index keys in non-skeleton lists

**`src/components/dashboard/transcript-viewer.tsx:436`** — segments have `start` (number); use `key={s.start}` (or `${s.start}-${i}` if duplicate starts are possible).

**`src/components/dashboard/subtitle-overlay.tsx:152`** — read context first; if it's text spans they may need a synthetic id.

**`src/app/playground/page.tsx:532,593`** — read context; these may turn out to be skeleton arrays after all.

**Deliverable:** PR titled `chore(frontend): consolidate error handling, named constants, eslint reasons`. Touches ~12 files, ~50 line diffs each. Zero behavior change.

---

## Phase 2 — Split the two hot files (5-7 hours, medium risk)

These are the two big rocks. Each gets its own PR.

### 2.1 Split `src/app/playground/page.tsx` (640 lines, 15 useState)

**Target shape:**

```
src/components/playground/
  index.ts
  Playground.tsx              — Container; wires query state to subcomponents
  RequestForm.tsx             — URL input, format select, language select, native_only toggle, translate_to
  ResponsePanel.tsx           — Result viewer (JSON pretty-print, segment table, raw text)
  RequestPreview.tsx          — Curl/JS/Python tabs, copy button
  ApiKeyCard.tsx              — Bearer token input (playground-only auth path)
  types.ts                    — RequestState, ResponseState, etc.
  utils.ts                    — Build query string, build curl preview, etc.
  hooks/
    useRequestState.ts        — Combine the 15 useState into a useReducer or grouped state

src/app/playground/page.tsx   — Becomes ~30 lines, just <Playground />
```

**Order of operations:**

1. Read the existing file end-to-end. Note where state slices are coupled.
2. Create `src/components/playground/types.ts` — extract every interface/type used internally.
3. Create `src/components/playground/utils.ts` — move pure functions (URL builder, curl builder, etc.).
4. Extract `RequestPreview.tsx` first (least coupled — pure render of curl/JS/Python from props).
5. Extract `ResponsePanel.tsx` next (also mostly presentational).
6. Extract `RequestForm.tsx` — this owns most form state.
7. Convert the 15 `useState` calls into a `useReducer` if any 5+ fields update together; otherwise group with `react-hook-form`.
8. Replace `process.env.NEXT_PUBLIC_API_URL` (line 637) with a value passed from the api client (or move that whole line into `api.ts` since it's building the curl string the user copies).
9. Final `page.tsx` is just `export default function Page() { return <Playground />; }`.

**Acceptance:** all features still work, `tsc --noEmit` clean, no file > 250 lines.

### 2.2 Split `src/components/dashboard/transcript-viewer.tsx` (545 lines, 8 useState, 5 useEffect)

**Target shape:**

```
src/components/transcript-viewer/
  index.ts
  TranscriptViewer.tsx        — Container; orchestrates player + segments
  PlayerPane.tsx              — YouTube IFrame mount + controls
  SegmentList.tsx             — Virtualized list of segments (memoize each row)
  SegmentRow.tsx              — Single segment; React.memo
  ExportToolbar.tsx           — Copy + Export menu
  TranslateToggle.tsx         — Original ⇄ Translated switch
  types.ts
  utils.ts                    — formatTimestamp, downloadBlob, etc.
  hooks/
    useTranscriptPlayer.ts    — wraps the YouTube player lifecycle (the 5 useEffects)
    useSegmentSync.ts         — keep active segment in sync with player time
```

**Order of operations:**

1. Move pure helpers to `utils.ts` (timestamp formatting, blob download).
2. Extract `useTranscriptPlayer` hook — this absorbs the 5 useEffects per §15.1.
3. Extract `SegmentRow` with `React.memo` (perf win).
4. Extract `SegmentList` — wrap `SegmentRow` in `.map()`. Stable key (`s.start`).
5. Extract `ExportToolbar` and `TranslateToggle` — pure presentational.
6. `TranscriptViewer` becomes the thin orchestrator.
7. Update import sites: existing import `@/components/dashboard/transcript-viewer` → `@/components/transcript-viewer`. Delete old file.

**Acceptance:** viewer still works (paste a YouTube URL, scrub through segments, export SRT). `useEffect` count per file ≤ 3.

### 2.3 Trim `src/app/dashboard/transcripts/page.tsx` (303 lines, 7 useState)

Smaller win, same pattern. Extract:

```
src/components/transcripts-history/
  TranscriptsHistory.tsx
  HistoryItem.tsx             — React.memo
  EmptyState.tsx
  utils.ts
```

Hoist debouncer to `useDebouncedValue` in `src/lib/hooks/useDebouncedValue.ts` (this is the second extracted hook → `src/lib/hooks/` is now justified per §15.2).

**Deliverables (3 PRs):**
- `refactor(playground): split into feature components`
- `refactor(transcript-viewer): split into feature folder, memoize segment rows`
- `refactor(transcripts-history): extract feature components, useDebouncedValue hook`

---

## Phase 3 — Performance (1-2 hours, low risk)

### 3.1 Code-split `recharts`

[`src/app/dashboard/usage/page.tsx:12`](../../frontend/src/app/dashboard/usage/page.tsx) imports recharts directly. Recharts is ~95 KB gz; on the dashboard index it's wasted bytes.

```typescript
// BEFORE
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

// AFTER
import dynamic from "next/dynamic";
const UsageChart = dynamic(() => import("@/components/usage/UsageChart"), {
  ssr: false,
  loading: () => <Skeleton className="h-64" />,
});
```

Move the chart JSX into `src/components/usage/UsageChart.tsx`.

### 3.2 Memoize segment row

If not already done in Phase 2.2:

```typescript
export const SegmentRow = memo(function SegmentRow(props: SegmentRowProps) {
  // ...
});
```

### 3.3 Verify segment list virtualization

If segments routinely exceed 100, install `@tanstack/react-virtual` and virtualize `SegmentList`. Skip if typical videos stay under that.

```bash
npm install @tanstack/react-virtual
```

**Deliverable:** PR `perf(frontend): code-split recharts, memoize segment rows`.

---

## Phase 4 — Folder hygiene (2-3 hours, low risk)

Last because earlier phases will have already moved things around.

### 4.1 Move `src/components/dashboard/{sidebar,topbar}.tsx` → keep where they are

These are dashboard-shell-only components used by `app/dashboard/layout.tsx`. They're the only legitimate residents of `src/components/dashboard/` now that transcript-viewer / subtitle-overlay / subtitle-settings-popover have moved out.

### 4.2 Lift `subtitle-overlay` + `subtitle-settings-popover`

Currently in `src/components/dashboard/`. These are the transcript-viewer's children — move into `src/components/transcript-viewer/` as part of Phase 2.2.

### 4.3 Split `src/lib/api.ts` (303 lines) — when it crosses 350

Not yet — at 303 lines it's at the soft target. When the next 1-2 endpoints are added, split per §12.3:

```
src/lib/api/
  index.ts
  client.ts        — api(), ApiError, RequestOptions
  types.ts         — shared envelopes
  auth.ts          — login, signup, logout, me
  transcripts.ts   — fetch, fetchAsUser, list, exports
  apiKeys.ts       — create, list, revoke
  billing.ts       — plans, checkout, subscription
  usage.ts
```

Migrate one namespace per PR. Update import sites: `import { auth } from "@/lib/api"` → still works because `index.ts` re-exports.

### 4.4 Create `src/lib/hooks/` (already justified by Phase 2.3 if `useDebouncedValue` extracted)

Per §15.3, also extract these as second-instances appear:
- `useCopyToClipboard` (currently inline in transcript-viewer copy button)
- `useKeyboardShortcut` (when first global shortcut lands)

**Deliverable:** PR `refactor(frontend): folder hygiene, hooks/ directory`.

---

## Out of scope (intentional)

- **Adding React Query.** §4.3 of CLAUDE.md treats this as a future, dedicated PR. Don't bundle.
- **Adding `dompurify` / `SafeRichHtml`.** Zero call sites need it today. Defer until a real consumer appears.
- **Adding `nuqs`.** `useSearchParams` is fine for current filter complexity.
- **Adding `next-international` or i18n.** Out of scope.
- **`sp-*` density tokens in tailwind.config.ts.** Mentioned in CLAUDE.md §11 as future; not blocking.

---

## Tracking checklist

Copy this into the PR description for each phase.

### Phase 0
- [ ] `package.json` has `type-check` script
- [ ] `src/lib/apiError.ts` created with `getApiErrorMessage`
- [ ] `src/lib/constants.ts` created with `SEARCH_DEBOUNCE_MS`, `BLOB_URL_TTL_MS`, `DEFAULT_PAGE_SIZE`
- [ ] `src/app/global-error.tsx` exists
- [ ] `src/app/dashboard/error.tsx` exists
- [ ] `npm run type-check` and `npm run lint` clean

### Phase 1
- [ ] Zero remaining `err instanceof ApiError ? err.message :` outside `apiError.ts`
- [ ] Zero `console.*` outside dev-guard or marketing template strings
- [ ] Every `eslint-disable` has a `--` reason
- [ ] All `setTimeout` literal numbers reference a constant
- [ ] All `key={i}` are inside skeleton arrays only
- [ ] `window.location.href` only at OAuth/Stripe call sites with a comment

### Phase 2
- [ ] No file > 250 lines (excluding `src/components/ui/` shadcn primitives)
- [ ] Playground feature folder exists at `src/components/playground/`
- [ ] Transcript viewer feature folder exists at `src/components/transcript-viewer/`
- [ ] `src/lib/hooks/useDebouncedValue.ts` exists
- [ ] No component has > 5 useState or > 3 useEffect

### Phase 3
- [ ] `recharts` loaded via `next/dynamic`
- [ ] Segment row uses `React.memo`
- [ ] Decision recorded on `@tanstack/react-virtual` (in or skip)

### Phase 4
- [ ] `src/lib/api/` split (when count justifies)
- [ ] `src/lib/hooks/` houses ≥ 2 shared hooks
- [ ] Old single-file locations deleted (no dead imports)

---

## Notes for the agent picking this up

- **Read [`frontend/CLAUDE.md`](../../frontend/CLAUDE.md) before each phase.** Don't refactor from memory.
- **Run `npm run type-check && npm run lint` after every phase**, not just at the end.
- **One PR per phase, max.** Don't compound risk.
- If a finding here disagrees with the current code (e.g. an `eslint-disable` was added since this audit), trust the current code and update this plan in the same PR.
- The `[videoId]/page.tsx` URL routing is the dashboard transcript viewer's entry point — touching it requires manual smoke test with a real YouTube URL.
