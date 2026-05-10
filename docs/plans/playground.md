# Playground

## What this is

The playground is an in-browser API tester. Anyone can visit `/playground` — no login required — paste an API key and one or more YouTube URLs, pick a format and language, and hit a button to actually call the live API. The response renders inline. The page also displays a continuously-updated `curl` one-liner that shows the exact command the user could run from a terminal to make the same request. It's part documentation, part demo, part developer tool.

The point is to flatten the path between "I'm reading the docs" and "I have a working call against my own data". A prospect can pick this up before signing up — the page renders fully, the form is interactive, and the curl preview reads correctly. They just need a key to actually fetch. That gates conversion to signup naturally without making the playground feel locked.

For logged-in users, the playground is a quality-of-life shortcut. The keys they've created in their dashboard are stashed in `localStorage` (the key-stash, populated by the API Keys page's create-key flow), and the playground reads from that stash to show their keys in a dropdown. They pick one and go. They never need to copy-paste from the dashboard into the playground.

This page deliberately uses one code block — the live curl preview. That's the entire reason the page exists, so it's not a documentation violation; it's a feature. No other code blocks render anywhere else on the page.

## UI/interaction idea

A single full-width page with a top-aligned hero ("Try the API in your browser") and below it a two-column layout. Left column: the request form. Right column: the results panel.

**The form (left column).**

- A "Get started" callout at the very top, only shown when no API key is selected: "Sign up free to get an API key" with a button leading to `/signup`. When a key is selected this collapses out of view.
- An API key field. If the user is logged in and has stashed keys, this is a dropdown listing each key by name and prefix (e.g. "Production · yt_live_AbCd…"), with the most recently created one preselected. If the user has no stashed keys (signed out, or signed in but no keys yet), this is a plain text input that accepts a pasted key. There's a small "Where do I get a key?" link next to it.
- A multi-line textarea for YouTube URLs, one URL per line. Placeholder text shows two example URLs to make the format obvious. Above the textarea, a small label: "URLs (one per line) — submitted in parallel".
- A format select: JSON, Text, SRT, VTT. JSON is the default.
- A language select: ~45 ISO 639-1 codes plus an "Auto-detect" option. Auto-detect is the default.
- A translate-to select: "Don't translate" (default) plus the same ~45 ISO 639-1 codes.
- A primary "Run" button on the right.

**The live curl preview.** A code block sitting between the form fields and the results panel — or at the bottom of the form column, depending on viewport. As the user fills the form, this block updates in real time to show the equivalent terminal command, including the URL-encoded YouTube URL, the format query parameter, the language and translate-to parameters when set, and the `Authorization: Bearer …` header (with the actual selected key when one is present, or a `<your-api-key>` placeholder when not). A "Copy" button sits in the top-right corner of the block.

**The results panel (right column).**

- Empty state on first load: a short illustration + "Submit a request to see the response here".
- After the user clicks Run, one result card per URL submitted. Cards stack vertically.
- Each card has a header strip with: the URL truncated, a status indicator (spinner during loading, green checkmark on success, red X on error), a source badge (`native` / `whisper` / `cache`) when known, the credit cost, and the latency in milliseconds.
- Below the header: video metadata when available — thumbnail, title, channel, duration. When the result is an error, this section is replaced with the typed error envelope from the API rendered cleanly (the `error`, `code`, and `message` fields shown one per line).
- Below the metadata: a collapsible "Raw response" block showing the JSON or text response with proper formatting. JSON is syntax-highlighted and starts collapsed (one click to expand) because it's often hundreds of lines. Text/SRT/VTT responses start expanded since they're more readable.
- A "Download" button on each card that saves the response in the chosen format with a sensible filename (`<videoId>.<ext>`).

When multiple URLs are submitted, all the request cards appear immediately in a "loading" state and resolve independently as their requests complete. Failures in one don't block the others.

## Backend

### Schema

The playground does not own any tables. It calls the existing public transcript endpoint, which already handles caching, audit logging, credit deduction, and rate limiting against the API key.

### Endpoints

- **`GET /v1/transcript`** (existing). The playground hits this endpoint, exactly the same way an external developer would. URL-encoded `url` parameter; optional `format`, `language`, `translate_to`; `Authorization: Bearer <key>` header. Returns the standard transcript envelope on success or the typed `{ error, code, message }` envelope on failure.

The playground does not call any cookie-authed `/me/*` routes. The whole point is for the page to be a faithful demonstration of the public API, behaving exactly as a third-party developer's HTTP client would behave. So the auth boundary the playground uses is identical to what a curl call would use.

### Logic

There is no backend logic specific to the playground. Rate limiting is handled by the standard middleware on `/v1/transcript` against the supplied key. Credits are deducted by the standard credit service. CORS must allow the frontend's origin and accept the `Authorization` header — covered in the deployment doc.

A small backend consideration: the playground submits multiple URLs in parallel. With a typical token-bucket rate limit of e.g. 10 requests per second, batches of 50 URLs from the same key will rate-limit themselves naturally. The frontend should display a `429` response on a per-card basis with a clear "Rate limited — try again in N seconds" message, not retry transparently. Letting users hit their own rate limit is part of how they learn what the limits are.

Edge cases:

- Invalid YouTube URL → the API returns a `400` with `code: 'INVALID_URL'`. The card renders the error envelope verbatim.
- Video has no captions and Whisper is unavailable → `404` with `code: 'NO_TRANSCRIPT'`. Same rendering.
- Insufficient credits → `402` with `code: 'PAYMENT_REQUIRED'`. The card surfaces this clearly. (When logged in, also show a small "Upgrade your plan" link in the card body.)
- Wrong API key → `401` with `code: 'UNAUTHORIZED'`. Card shows the error and the form's API key field highlights with a destructive border.

## Frontend

The playground page lives at `frontend/src/app/playground/page.tsx`. It is a client component because all of the interesting behaviour — form state, live curl preview, parallel fetch dispatch, per-card render states — is browser-side. There is no server-side data needed before the page can render.

**Form state.** Local React state for: the selected key (id + plaintext), the textarea contents, the format, the language, the translate-to. The textarea is parsed into an array of URLs by splitting on newlines and trimming/discarding empty lines.

**Key stash integration.** On mount, read `localStorage` for the key-stash (an array of `{ id, prefix, plaintext, createdAt }`). If present and non-empty, render the dropdown with the stashed entries; otherwise render a plain text input. The user can also manually paste a key into a dropdown-mode form by clicking a small "Use a different key" link that switches the field to text-input mode for the current session.

**Keys are never sent to our own backend except as the `Authorization` header on the transcript call.** They are not stored server-side, not logged, not telemetered. The key-stash only ever lives in the user's browser localStorage. This is worth pointing out because it shapes the trust model — a user pasting a teammate's key into the playground hasn't leaked it anywhere new.

**Live curl preview generator.** A pure function: given the current form state, return the exact curl one-liner string. It URL-encodes the YouTube URL, conditionally appends `&format=`, `&language=`, `&translate_to=` based on which fields are set to non-default values, and substitutes the API key into the `Authorization` header (or the placeholder when not set). The function is called on every form-state change and the resulting string is rendered inside the code block. The "Copy" button uses `navigator.clipboard.writeText`.

**Submit handler.** On Run, build the list of URLs from the textarea, create one "pending" result card per URL with a stable id, and kick off a `Promise` per URL using the typed API client (or a thin wrapper that doesn't hit `/me/*` since this is the public API path). Update each card's state independently as its promise settles — `success` with the payload, or `error` with the envelope. Don't await all of them serially; they should resolve as fast as each request returns.

**Result cards.** A `ResultCard` component receives the URL, its current state (`loading | success | error`), and the response or error. It renders the appropriate header strip and body. The "Raw response" expand/collapse is local component state. The "Download" button uses the same client-side blob-download pattern the viewer's export buttons use.

**Component layout.** Form lives in `components/playground/RequestForm.tsx`, results in `components/playground/ResultCard.tsx`, the curl preview in `components/playground/CurlPreview.tsx`. The page composes them with a simple grid layout.

**Public access.** The page sits outside `/dashboard/*`, so the dashboard layout's auth gate does not apply. It uses the same site nav and footer as the marketing pages. Logged-in users still see the marketing nav (with "Login" / "Get started"), since the playground intentionally does not advertise auth state — it's a demo first, a power-user tool second.

**Acceptance from the user's seat.** A signed-out visitor who has obtained a key (e.g. friend's, signup-and-create flow, etc.) should be able to land on the page, paste the key, paste a YouTube URL, click Run, and see a transcript come back with no other configuration. A signed-in user with one or more keys should see them auto-populated and be one click away from running a request.

## Dependencies

- `marketing-site.md` — the playground reuses the site nav and footer. The "Sign up to get a key" CTA links into the signup flow defined there.
- `dashboard.md` — the API Keys page populates the localStorage key-stash that the playground's dropdown reads from.

## Verification

- Visit `/playground` while signed out and with no localStorage entries. The page should render with the API key field as a plain text input and the "Sign up to get a key" callout visible at the top of the form.
- Type a fake key into the field and watch the curl preview's `Authorization` header update in real time as you type. Clear the field — the header should revert to `<your-api-key>`.
- Paste a real key, paste two YouTube URLs (one per line), click Run. Both result cards should appear immediately as loading and resolve independently. The faster one should populate first.
- Submit a deliberately malformed URL alongside two valid ones. Two cards should succeed, one should render the typed error envelope (`error`, `code`, `message`). The successes are unaffected.
- Click "Copy" on the curl preview, paste into a terminal, and run it — the response should match what the page rendered for that request.
- Sign in, create a new API key from the dashboard, return to `/playground`. The new key should appear in the dropdown and should be preselected (most recently created wins).
- Sanity check the network tab: the only outbound calls from the playground should be to `<NEXT_PUBLIC_API_URL>/v1/transcript`. There should be no calls to `/me/*` and no calls to any analytics endpoint that includes the API key.
- One-line equivalent of the page's behaviour: `curl 'https://<backend>/v1/transcript?url=<encoded>&format=json' -H 'Authorization: Bearer yt_live_…'`.
