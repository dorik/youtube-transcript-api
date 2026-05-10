# Frontend Guide for AI Agents

You are editing `frontend/`, a Next.js 14 App Router app (TS, Tailwind, shadcn/ui, react-hook-form, Sonner, TanStack React Query). API calls go through typed service functions and React Query hooks — components must not call API clients inline.

This file is the contract you must follow. Read it before writing code; reread the relevant section before each edit.

---

## 0. Read this first — the five rules you will be tempted to break

1. **No `any`.** Anywhere. Use `unknown` + a narrowing check, or define the type. ([§9](#9-type-safety))
2. **No inline functions between hook calls.** Hooks come first, in the order in [§2](#2-hook-ordering). Plain functions and helpers go after, never between.
3. **No copying props into `useState` and syncing with `useEffect`.** Use the prop directly, remount with `key=`, or derive the delayed value explicitly. ([§14.1](#141-no-derived-state-from-props))
4. **No `useEffect` to react to a state change you just set in a click handler.** Call the logic directly in the handler. ([§14.2](#142-no-useeffect-as-event-handler))
5. **No new objects/arrays inline as props to memoized children.** Wrap in `useMemo` / `useCallback`. ([§14.5](#145-no-unstable-references-as-props))

If your edit would violate any of these, stop and refactor. Do not file a TODO.

---

## 1. Quality gates (blocking)

Before you say "done":

```bash
cd frontend
npm run type-check     # zero errors
npm run lint           # zero warnings
```

If either fails, your change is not done. Fix the cause, do not silence with `// @ts-ignore` or `eslint-disable`.

Do not replace type errors with casts just to pass this gate.

---

## 2. Hook ordering

Every component follows this order. No exceptions.

```typescript
function MyComponent({ url }: Props) {
  // 1. Context hooks
  const router = useRouter();
  const params = useParams();
  const search = useSearchParams();

  // 2. useState — group by concern (form fields together, UI toggles together)
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // 3. useRef
  const inputRef = useRef<HTMLInputElement>(null);

  // 4. React Query hooks — server state only
  const thingQuery = useThingQuery(url);

  // 5. useMemo — derived state
  const videoId = useMemo(() => extractVideoId(url), [url]);

  // 6. useCallback — event handlers passed as props or used by hooks below
  const handleSubmit = useCallback(() => { /* ... */ }, [/* deps */]);

  // 7. useEffect — ALWAYS the last hook category
  useEffect(() => { /* ... */ }, [/* deps */]);

  // 8. Plain helper functions (only pure formatters, never passed as props)
  function formatLabel(s: string) { return s.trim().slice(0, 60); }

  // 9. Early returns / loading gates
  if (!videoId) return null;

  // 10. JSX
  return <div>{/* ... */}</div>;
}
```

Rules:
- `useState` is **never** placed after `useEffect`, `useCallback`, `useMemo`, or any other hook.
- `useEffect` is **always** the last hook before plain helpers.
- No `function` declarations between hook calls. Convert to `useCallback` or move below all hooks.
- React Query hooks slot between `useRef` and `useMemo`. Do not hide React Query hooks inside `useEffect`.

---

## 3. Component complexity (soft targets, not hard blockers)

These are guidelines, not gates. Use them to decide when to split — exceeding them on its own is not a CI failure.

| Type | Aim for | Consider splitting around | When you exceed |
|------|---------|----------------------------|-----------------|
| Route page (`page.tsx`) | ≤ 150 lines | 250 lines | Extract a container component into `src/features/{feature}/` |
| Container component | ≤ 250 lines | 400 lines | Split into sub-components + custom hooks |
| Presentational component | ≤ 150 lines | 250 lines | Split into smaller pieces |
| Hook file | ≤ 200 lines | 300 lines | Split by sub-concern |
| `src/lib/*.ts` | ≤ 200 lines | 300 lines | Split by subdomain |

| Metric | Soft threshold | Action |
|--------|---------------|--------|
| `useState` per component | > 5 | Consider `useReducer` or `react-hook-form` |
| `useEffect` per component | > 3 | Extract effects into custom hooks |
| Props per component | > 10 | Group into typed objects or a Context |

These thresholds are **suggestions**. Don't refactor a 260-line file just to hit 250. Refactor when you're already touching the file and the split makes the next change easier.

---

## 4. Data Fetching

### 4.1 Components use query hooks, never inline API calls

Components must **never** call `fetch()` directly. They must **never** call API namespaces inline. They must **never** read `process.env.NEXT_PUBLIC_API_URL` themselves.

```typescript
// BAD
const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/me/transcript?...`);

// BAD
import { transcripts } from "@/lib/api";
const data = await transcripts.fetchAsUser({ url });

// BAD
const { keys } = await apiKeys.list();

// GOOD
const { data, isLoading } = useApiKeysQuery();
const createKeyMutation = useCreateApiKeyMutation();
```

If a new endpoint is needed, add it to the service layer first, then expose it through a query/mutation hook. Do not add a one-off fetch or API call in a component.

### 4.2 Service files own HTTP calls

Services are the only feature-level files that define HTTP requests. Keep them framework-free: no React, no hooks, no toast. Service exports should be `createApi(...)` constants backed by a small query/request builder function.

```typescript
// src/features/oauth/oauth.service.ts
import { apiClient } from "@/lib/http/client";
import { createApi } from "@/lib/http/createApi";
import { methodsEnums } from "@/lib/http/constants";

export interface GetOAuthUrlKeys {
  workspaceId: string;
}

export interface GetOAuthUrlResponse {
  url: string;
}

function getOAuthUrlQuery({ workspaceId }: GetOAuthUrlKeys) {
  return {
    url: `/workspaces/${workspaceId}/oauth-url`,
    method: methodsEnums.GET,
  };
}

export const getOAuthUrl = createApi<GetOAuthUrlKeys, GetOAuthUrlResponse>({
  queryFn: apiClient,
  query: getOAuthUrlQuery,
});
```

Service rules:
- One service file per domain when practical: `{domain}.service.ts`.
- Every function has explicit request and response types.
- Build request details in named helpers like `getOAuthUrlQuery`, `createApiKeyQuery`, etc.
- Export service functions as `const name = createApi<TVariables, TResponse>({ queryFn: apiClient, query })`.
- Services may compose API calls, normalize request params, and return typed data.
- Services do not know about React Query, components, toasts, routing, or localStorage unless the domain explicitly requires browser storage.

### 4.3 Query files own TanStack React Query hooks

Query hooks live beside the feature they serve. Components import hooks from the feature public surface, not services.

```typescript
// src/features/oauth/oauth.queries.ts
import { useMutation } from "@tanstack/react-query";
import { getOAuthUrl } from "./oauth.service";
import type { GetOAuthUrlKeys, GetOAuthUrlResponse } from "./types";

export const useGetOAuthUrl = () => {
  return useMutation<GetOAuthUrlResponse, Error, GetOAuthUrlKeys>({
    mutationFn: (params) => getOAuthUrl(params),
  });
};
```

Query rules:
- Use `useQuery` for reads and `useMutation` for writes/actions.
- Use a per-feature `queryKeys.ts` factory; no inline string keys.
- Mutations use `retry: false` unless there is a product reason to retry.
- Invalidate or update query cache after successful mutations instead of manually re-fetching from components.
- Components should not use `useEffect` to fetch server data. If you see `useEffect(() => { apiKeys.list()... })`, extract a query hook.

### 4.4 The `api()` wrapper is the contract

`src/lib/api.ts` is the single source of truth for endpoint shapes. Every endpoint:
- Has a TypeScript request type and a TypeScript response type — no `any`, no `Record<string, unknown>` masquerading as a real type.
- Throws `ApiError` (already defined in that file) on non-2xx; services let it bubble to React Query.
- Uses `credentials: 'include'` so the JWT cookie travels (already wired in `api()`).

### 4.5 React Query defaults

- `QueryProvider` configures global `onError` for queries and mutations when possible.
- Prefer global toast/error handling. Add local `onError` only when the component needs custom recovery UX.
- Default `staleTime: 30_000`. Never `staleTime: 0` unless data is genuinely real-time.
- Keep `refetchIntervalInBackground` at the default `false`.

---

## 5. State management — pick the right tool

| Use case | Tool |
|----------|------|
| Server data | TanStack React Query hooks from feature `*.queries.ts` |
| Simple UI toggle (1–2 booleans) | `useState` |
| 5+ coordinated fields | `useReducer` with typed actions |
| Forms with validation | `react-hook-form` + zod |
| Survives page refresh | `localStorage` (manual) — Zustand is overkill for current scope |
| Read-only scope from layout | React Context, value **must** be `useMemo`-wrapped |
| URL-reflectable filters | `useSearchParams` (App Router native) |

Context value memoization is mandatory:

```typescript
// BAD — new object every render, every consumer re-renders
return <Ctx.Provider value={{ user, workspaceId }}>{children}</Ctx.Provider>;

// GOOD
const value = useMemo(() => ({ user, workspaceId }), [user, workspaceId]);
return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
```

---

## 6. Security

### 6.1 HTML sanitization

`dangerouslySetInnerHTML` is **banned** in this codebase. Today there are no approved wrappers because there's no need. If a feature requires rendering server-supplied HTML:
1. Add `dompurify` (or equivalent) as a dependency.
2. Create `src/components/shared/SafeRichHtml.tsx` that runs sanitization.
3. Then use it — never inline.

If you find existing `dangerouslySetInnerHTML` (other than the theme-bootstrap script in `app/layout.tsx`), flag it and fix it.

### 6.2 URL validation

Never `window.open` an API-supplied URL directly. Validate scheme + origin first.

```typescript
// BAD
window.open(response.url, "_blank");

// GOOD — call a helper that checks https: + an allowlist
openTrustedUrl(response.url);
```

If `openTrustedUrl` doesn't exist yet, add it to `src/lib/openTrustedUrl.ts` with `https:`-only and an explicit origin allowlist before using.

### 6.3 Navigation

App Router only — never `window.location.href = ...` for SPA navigation.

```typescript
// BAD
window.location.href = `/dashboard/transcripts/${id}`;

// GOOD
router.push(`/dashboard/transcripts/${id}`);
```

`window.location.href` is acceptable **only** for full-document redirects after sign out, OAuth handoffs, and Stripe checkout.

### 6.4 Auth

- JWT cookie only (`yt_session`). No `localStorage` tokens, no `Authorization: Bearer` headers from the dashboard.
- The playground page may use a Bearer API key supplied by the user — that is the one and only exception. Do not add other call sites.
- `api()` already sets `credentials: 'include'`. Don't override it.

---

## 7. Inline functions

### 7.1 No function definitions between hook calls

```typescript
// BAD
const [v, setV] = useState("");
function onChange(next: string) { setV(next); }   // ← between hooks
useEffect(() => { /* ... */ }, []);

// GOOD
const [v, setV] = useState("");
const onChange = useCallback((next: string) => setV(next), []);
useEffect(() => { /* ... */ }, []);
```

### 7.2 Multi-statement JSX handlers must be extracted

```typescript
// BAD
onClick={() => {
  setOpen(false);
  onChanged();
  toast.success("Saved");
}}

// GOOD
const handleConfirm = useCallback(() => {
  setOpen(false);
  onChanged();
  toast.success("Saved");
}, [onChanged]);

onClick={handleConfirm}
```

Single-statement inline handlers (`onClick={() => setOpen(false)}`) are fine.

### 7.3 Debounced handlers use lodash

Use `lodash/debounce` for debounced handlers. Memoize the debounced function and cancel it on unmount.

```typescript
// GOOD — debounced side effect / action
const handleSearch = useMemo(
  () => debounce((query: string) => runSearch(query), 500),
  [runSearch],
);

useEffect(() => () => handleSearch.cancel(), [handleSearch]);

<Input onChange={(e) => handleSearch(e.target.value)} />
```

Do **not** debounce the state setter that controls an input's `value`; the field will lag or appear stuck.

```typescript
// BAD — controlled value updates only after the debounce delay
const handleSearch = useMemo(
  () => debounce(({ target }: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(target.value);
  }, 500),
  [],
);

<Input value={search} onChange={handleSearch} />

// GOOD — input updates immediately, query key updates later
const [search, setSearch] = useState("");
const [query, setQuery] = useState("");
const updateQuery = useMemo(
  () => debounce((next: string) => setQuery(next), SEARCH_DEBOUNCE_MS),
  [],
);

useEffect(() => () => updateQuery.cancel(), [updateQuery]);

<Input
  value={search}
  onChange={(e) => {
    setSearch(e.target.value);
    updateQuery(e.target.value);
  }}
/>
```

Use direct `debounce(...)` for callbacks/events. When a controlled input drives a query/filter, keep the rendered input state immediate and debounce the query/filter update separately.

### 7.4 Pure utilities go in `src/lib/`

Date math, string formatting, URL parsing — extract to `src/lib/{concern}.ts`. Do not inline them inside component bodies. Existing examples: `src/lib/youtube-url.ts`, `src/lib/languages.ts`.

---

## 8. Error handling

### 8.1 Boundaries (planned ladder)

```
Layer 1: app/global-error.tsx              — Root fallback (add if missing)
Layer 2: app/dashboard/error.tsx           — Dashboard boundary
Layer 3: Per-route error.tsx               — High-risk routes (transcript viewer, billing)
Layer 4: React Query/global toast handling — User-visible failure
```

If you touch a route that lacks an `error.tsx` and it does any non-trivial work, add one.

### 8.2 Extract API error messages with one helper

Components should not manually catch server-data query errors. For local async actions that are not React Query mutations, use `src/lib/apiError.ts` with `getApiErrorMessage(error, fallback)`.

```typescript
// BAD
catch (err) {
  toast.error(err instanceof ApiError ? err.message : "Failed");
}

// GOOD
catch (err) {
  toast.error(getApiErrorMessage(err, "Failed"));
}
```

### 8.3 No silent catches

`.catch(() => {})` is banned. Minimum: a `console.warn` in dev. Better: a toast or a Sentry call.

```typescript
// BAD
fetcher().catch(() => {});

// GOOD
fetcher().catch((err) => {
  if (process.env.NODE_ENV !== "production") console.warn("fetcher failed", err);
});
```

### 8.4 Async event handlers must handle errors

```typescript
// BAD — if upload throws, the user sees nothing
void upload(file).then((src) => editor.insert(src));

// GOOD
void upload(file)
  .then((src) => editor.insert(src))
  .catch(() => toast.error("Upload failed"));
```

### 8.5 Bulk mutations use `Promise.all`, not closure counters

```typescript
// BAD — race when callbacks fire concurrently
let done = 0;
ids.forEach((id) => mutate(id, { onSuccess: () => { done++; if (done === ids.length) finish(); } }));

// GOOD
const results = await Promise.all(ids.map((id) => mutateAsync(id).catch(() => null)));
const failed = results.filter((r) => r === null).length;
```

---

## 9. Type safety

- **Zero `any`** in `src/app/`, `src/components/`, `src/lib/`. None.
- The only allowed exception: a third-party adapter where the upstream types are wrong, marked with `// any: <reason>` directly above.
- Component props always have an explicit `interface` or `type`. No `props: any`.
- Don't suppress missing modules with `// @ts-ignore` — install types or write `.d.ts`.
- `npm run type-check` passes before merge.

`unknown` + a runtime narrow is the right escape hatch:

```typescript
function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

try { /* ... */ } catch (e) {
  if (isApiError(e)) toast.error(e.message);
  else toast.error("Unexpected error");
}
```

---

## 10. Code quality

### 10.1 No TODO stubs as click handlers

```typescript
// BAD
<Button onClick={() => console.log("TODO: implement")}>Save</Button>

// GOOD: implement OR
<Button disabled title="Coming soon">Save</Button>
// OR remove the button entirely.
```

### 10.2 No `console.*` in production code

`console.log`, `console.error`, `console.warn` only inside `if (process.env.NODE_ENV !== "production")`. For real logging use Sentry (when added) and toasts.

### 10.3 No `eslint-disable` without a reason

Every disable directive must include a `--` reason:

```typescript
// BAD
// eslint-disable-next-line react-hooks/exhaustive-deps

// GOOD
// eslint-disable-next-line react-hooks/exhaustive-deps -- effect runs only on mount; subsequent prop changes are handled by ResetButton
```

### 10.4 No magic numbers

Lift timeouts, debounce delays, page sizes, etc. to named constants at the top of the file or in `src/lib/constants.ts`.

```typescript
// BAD
setTimeout(close, 300);

// GOOD
const CLOSE_DELAY_MS = 300;
setTimeout(close, CLOSE_DELAY_MS);
```

---

## 11. Styling

This codebase does **not** currently have `sp-*` density tokens — the source guide's banned-class list does not apply yet. Until they're configured in [tailwind.config.ts](tailwind.config.ts):

- Use Tailwind's standard spacing scale (`p-4`, `gap-2`, etc.).
- Be **consistent** within a feature: if a card uses `p-6`, sibling cards do too.
- Use shadcn/ui primitives in [src/components/ui/](src/components/ui/) for buttons, inputs, dialogs — don't restyle them inline.
- Color: only `bg-*`/`text-*` tokens that map to CSS vars in [tailwind.config.ts](tailwind.config.ts) (e.g. `bg-card`, `text-muted-foreground`). No raw hex.
- Dark mode: every visual change must work in both `light` and `dark` (themed via `next-themes`).

When `sp-*` tokens are introduced, this section gets the banned-class list.

---

## 12. File structure

### 12.1 Where things live (today)

```
frontend/src/
  app/                          — Next.js App Router routes
    layout.tsx                  — Root layout, theme bootstrap
    page.tsx                    — Marketing home
    dashboard/                  — Authenticated dashboard
      layout.tsx                — Sidebar + topbar wrapper
      page.tsx                  — Dashboard index
      transcripts/              — Transcript history + viewer
      api-keys/, usage/, billing/
    playground/                 — API playground (optional Bearer auth)
    login/, signup/             — Auth flows
    docs/, pricing/             — Marketing
  components/
    ui/                         — shadcn primitives. Do NOT restyle.
    dashboard/                  — Dashboard-only shared components
    marketing/                  — Marketing-only shared components
    transcripts-history/        — Small shared/presentational feature pieces
  features/
    playground/                 — Feature containers, services, queries, helpers
    transcript-viewer/
  lib/
    api.ts                      — THE typed API client. Single source of truth.
    youtube-url.ts              — URL parsing/normalization
    languages.ts                — ISO code → name map
    youtube-player.ts           — IFrame player helpers
    subtitle-settings.ts, key-stash.ts, utils.ts
```

### 12.2 Per-feature folder shape (the convention to follow)

When a route or workflow accumulates more than one component, service, query hook, or helper, lift it into its own folder under `src/features/{feature}/`. Small presentational-only pieces that are reused by a dashboard route may live under `src/components/{feature}/`, but server-data features belong in `src/features/`.

```
src/features/{feature}/
  index.ts              — Re-exports the public surface (named exports only)
  {Feature}.tsx         — The container/entry component (≤ 250 lines target)
  {Subcomponent}.tsx    — Presentational pieces split out from the container
  types.ts              — Types shared across this feature's files
  utils.ts              — Pure helpers used only by this feature (≤ 200 lines target)
  {feature}.service.ts  — Typed framework-free createApi exports
  {feature}.queries.ts  — useQuery/useMutation hooks only
  queryKeys.ts          — Query key factory; no inline string keys
  hooks/                — Hooks shared across files in this feature
    use{Behavior}.ts
  __tests__/            — Co-located tests (when added)
```

Rules:

- **`types.ts` is mandatory** for any feature with > 1 component. Component-local prop types stay in the component file; anything shared (entity shapes, event payloads, enums) moves to `types.ts`.
- **`utils.ts` is for pure functions only** — no React, no API calls, no state. If a util is used outside this feature, promote it to `src/lib/{concern}.ts`.
- **`*.service.ts` is for API/service functions only** — no React hooks, no components, no toast. Components do not import services directly.
- **`*.queries.ts` is for TanStack React Query hooks only** — components import these hooks for server data through the feature `index.ts`.
- **`hooks/`** appears when the feature owns 2+ custom hooks ([§15.2](#152-where-to-put-it)). One hook can stay alongside its consumer.
- **`index.ts`** re-exports only what other features should consume — keep internals private. Example:
  ```typescript
  // src/features/transcript-viewer/index.ts
  export { TranscriptViewer } from "./TranscriptViewer";
  export type { TranscriptViewerProps } from "./types";
  ```

Existing today (do not refactor unless you're already touching them):
- `src/features/transcript-viewer/` — transcript viewer feature folder.
- `src/features/playground/` — playground route feature folder.
- `src/components/dashboard/{sidebar,topbar,subtitle-overlay,subtitle-settings-popover}.tsx` — same rule.

### 12.3 API client / service layer

`src/lib/api.ts` is the low-level typed API client and endpoint-shape source of truth. Feature service files call it; components do not. As it grows, split `src/lib/api.ts` by subdomain — do **not** create one-off fetch helpers in components.

```
src/lib/api/
  index.ts              — Re-exports the public client (api, ApiError, every namespace)
  client.ts             — Low-level api() wrapper, ApiError, RequestOptions
  types.ts              — Shared envelopes (ApiError shape, paginated response, etc.)
  auth.ts               — auth.* — login/signup/logout/me
  transcripts.ts        — transcripts.* — fetchAsUser, list, exports
  apiKeys.ts            — apiKeys.* — create/list/revoke
  billing.ts            — billing.* — plans, checkout, subscription
  usage.ts              — usage.*
```

Rules:

- **Every endpoint has an explicit request type AND response type.** No `any`, no `Record<string, unknown>` masquerading as a real type. Types live in `src/lib/api/types.ts` (shared) or alongside their endpoint (feature-specific).
- **Throw `ApiError` on non-2xx.** Already implemented in `client.ts` — don't re-implement per call site.
- **Never read `process.env.NEXT_PUBLIC_API_URL` outside `client.ts`.**
- **Never call `src/lib/api.ts` directly from a component.** Add or reuse a service function, then expose a query/mutation hook.
- Until the split happens, keep endpoint definitions in the existing flat `src/lib/api.ts` — but split when it crosses ~300 lines.

### 12.4 Pure utilities → `src/lib/`

Pure functions used by **multiple features** live at `src/lib/{concern}.ts`. Examples already in the repo: `youtube-url.ts`, `languages.ts`, `youtube-player.ts`, `subtitle-settings.ts`, `utils.ts`.

Decision tree for where a helper goes:

| Used by | Put it in |
|---------|-----------|
| One component | Same file (top-of-file `function`) |
| Multiple files in one feature | `src/features/{feature}/utils.ts` |
| Multiple features | `src/lib/{concern}.ts` |
| API request/response shapes | `src/lib/api/types.ts` (or feature endpoint file) |
| App-wide constants (timeouts, page sizes) | `src/lib/constants.ts` |

### 12.5 Hooks

`src/lib/hooks/` is for UI/browser behavior shared across features. It is **not** for server data hooks; React Query hooks live in `src/features/{feature}/{feature}.queries.ts`.

```
src/lib/hooks/
  useCopyToClipboard.ts
  useKeyboardShortcut.ts
  …
```

Each hook gets its own file (one hook per file). No barrel `index.ts` in `src/lib/hooks/` — import directly so tree-shaking works.

### 12.6 Named exports only

```typescript
// BAD
export default function TranscriptViewer() { /* ... */ }

// GOOD
export function TranscriptViewer() { /* ... */ }
```

Exception: Next.js requires `export default` for `page.tsx`, `layout.tsx`, `error.tsx`, `loading.tsx`, `not-found.tsx`, `route.ts`. Use default there, named everywhere else.

### 12.7 Imports

- Always use `@/` alias from [tsconfig.json](tsconfig.json) — no `../../../` chains.
- Components import from `@/lib/*`, never the other way around.
- No circular imports.

---

## 13. Performance

### 13.1 Virtualize long lists

Anything that may exceed ~100 items needs `@tanstack/react-virtual`. Currently nothing in the app does, but the transcripts history list and the segment list inside the viewer are candidates as users accumulate data.

### 13.2 Code-split heavy deps

Use `next/dynamic` for anything ≥ 50 KB gz that isn't above-the-fold:

- `recharts` (already a dep — split when you actually render charts).
- Future: TipTap, DnD Kit if introduced.

### 13.3 Memoize what gets passed down

- List-item components rendered inside `.map()` → `React.memo`.
- Context provider values → `useMemo` ([§5](#5-state-management-pick-the-right-tool)).
- Callbacks passed to memoized children → `useCallback`.

### 13.4 No `new Date()` in render body

```typescript
// BAD — new Date every render
<span>{formatRelative(new Date(item.createdAt))}</span>

// GOOD
const formatted = useMemo(() => formatRelative(new Date(item.createdAt)), [item.createdAt]);
<span>{formatted}</span>
```

For lists, prefer formatting once outside the row component or memoizing inside a `memo`-wrapped row.

### 13.5 Polling respects tab visibility

Manual `setInterval` polling must check `document.hidden` and skip. React Query polling must leave `refetchIntervalInBackground` at the default `false`.

### 13.6 `staleTime`

- Default: `30_000`.
- Stable data (user profile, plan): `60_000+`.
- Never `0` unless truly real-time.

---

## 14. Banned React anti-patterns

### 14.1 No derived state from props

```typescript
// BAD — local state mirrors prop, synced with effect
const [local, setLocal] = useState(filters);
useEffect(() => setLocal(filters), [filters]);

// GOOD — controlled
<FilterEditor filters={filters} onChange={onChange} />

// GOOD — uncontrolled with reset on identity change
<FilterEditor key={filterId} defaultFilters={filters} onChange={onChange} />

// GOOD — derive delayed filter state separately when needed
const [queryFilters, setQueryFilters] = useState(filters);
```

### 14.2 No `useEffect` as event handler

```typescript
// BAD
const [submit, setSubmit] = useState(false);
useEffect(() => { if (submit) { run(); setSubmit(false); } }, [submit]);
onClick={() => setSubmit(true)}

// GOOD
onClick={() => run()}
```

### 14.3 No array index as key in dynamic lists

```typescript
// BAD
items.map((item, i) => <Card key={i} data={item} />)

// GOOD
items.map((item) => <Card key={item.id} data={item} />)

// ACCEPTABLE — static skeleton arrays that never reorder
Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} />)
```

### 14.4 No direct DOM manipulation

```typescript
// BAD
document.getElementById("input")?.focus();

// GOOD
const inputRef = useRef<HTMLInputElement>(null);
inputRef.current?.focus();
```

Exception: file download via a transient `document.createElement("a")` — extract to `src/lib/downloadFile.ts` so the hack lives in one place.

### 14.5 No unstable references as props

```typescript
// BAD — new object every render; defeats memo
<Row style={{ width: col.size }} />

// GOOD
const style = useMemo(() => ({ width: col.size }), [col.size]);
<Row style={style} />
```

### 14.6 No `[key: string]: any` in prop interfaces

```typescript
// BAD
interface Props { item: { id: string; [key: string]: any } }

// GOOD — model the real shape
interface Props { item: TranscriptHistoryItem }
```

If you don't know the shape, define `unknown` and narrow at the use site. Components with > 10 props get refactored — group related props into a typed object or move shared state into Context.

---

## 15. Custom hooks

### 15.1 When to extract

Extract a hook when:
- The same `useState` + `useEffect` combo appears in 2+ components.
- A component has 3+ `useEffect`s.
- The behavior has a verb name (`useKeyboardShortcut`, `useCopyToClipboard`).

### 15.2 Where to put it

| Scope | Location |
|-------|----------|
| Used by 1 component | Same file or sibling file in that route folder |
| Used by 2+ components in same feature | `src/features/{feature}/hooks/` |
| Used across features | `src/lib/hooks/` |

### 15.3 Recommended shared hooks (build when needed)

Don't pre-build these — but when the second copy of one of these patterns appears, extract to `src/lib/hooks/`:

| Hook | Purpose |
|------|---------|
| `useCopyToClipboard()` | Copy text + toast + try/catch around clipboard API |
| `useKeyboardShortcut(binding, handler, enabled?)` | Global keybindings |
| `useInfiniteScrollSentinel(onLoadMore)` | IntersectionObserver-based infinite scroll |
| `useMultiSelect<T>()` | Set-based select with toggle/selectAll/clear |

### 15.4 Naming

- `use` prefix always.
- Name describes behavior, not implementation: `useKeyboardShortcut`, not `useKeydownListener`.
- Return stable references: handlers from `useCallback`, derived values from `useMemo`.

---

## 16. Memory safety & cleanup

### 16.1 Every timer must be cleaned up

```typescript
// BAD — no cleanup
onClick={() => setTimeout(() => setShow(false), 2000)}

// GOOD
const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
useEffect(() => () => {
  if (timerRef.current) clearTimeout(timerRef.current);
}, []);

const handle = useCallback(() => {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => setShow(false), 2000);
}, []);
```

### 16.2 `addEventListener` must match `removeEventListener`

Same function reference both times — no anonymous functions on `addEventListener`.

```typescript
useEffect(() => {
  function onKey(e: KeyboardEvent) { /* ... */ }
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
```

### 16.3 Subscriptions close on unmount

`EventSource`, `BroadcastChannel`, `IntersectionObserver` — all disconnect/close in cleanup.

### 16.4 Async state updates guard against unmount

This applies only to non-server async work that cannot be represented as a React Query hook. Do not use this pattern for API reads; create a query hook instead.

```typescript
useEffect(() => {
  let cancelled = false;
  readBrowserThing(id).then((data) => {
    if (!cancelled) setData(data);
  });
  return () => { cancelled = true; };
}, [id]);
```

### 16.5 Singletons expose `cleanup()`

Any module-level singleton with `init()` exposes `cleanup()` to tear down listeners/timers/channels. Call `cleanup()` on logout.

---

## 17. Accessibility

### 17.1 Icon-only buttons must have `aria-label`

```typescript
// BAD
<Button variant="ghost" size="icon"><Filter className="size-4" /></Button>

// GOOD
<Button variant="ghost" size="icon" aria-label="Filter">
  <Filter className="size-4" />
</Button>
```

### 17.2 Click handlers go on semantic elements

`<button>`, `<a>`, `<input>` — never `<div onClick>`. For overlay dismissal use a `<button type="button">` styled flat:

```typescript
<button
  type="button"
  className="fixed inset-0 appearance-none bg-transparent cursor-default"
  onClick={() => setOpen(false)}
  aria-label="Close"
  tabIndex={-1}
/>
```

### 17.3 Forms use `<label>` correctly

shadcn's `<Label htmlFor={id}>` paired with the input's `id` is the only pattern. Never wrap an input in a label without `htmlFor`.

---

## 18. When in doubt

- Re-read [§0](#0-read-this-first-the-five-rules-you-will-be-tempted-to-break).
- If the rule conflicts with a pattern already in the codebase: prefer the rule, but flag the inconsistency in your PR description rather than fixing every old call site silently.
- This guide is **living**. If a rule is wrong or impossible given the current scope, propose an edit to this file in the same PR.
