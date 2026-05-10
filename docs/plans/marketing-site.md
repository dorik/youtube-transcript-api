# Marketing Site

## What this is

The marketing site is everything a visitor sees before they log in. It exists to do three jobs and only three jobs: explain what the product does in under ten seconds, show what it costs, and give a developer enough information to know whether the API will work for them. Anything beyond that — onboarding flows, dashboards, in-app tutorials — lives behind authentication.

Concretely the marketing site is three pages: a landing page at `/`, a pricing page at `/pricing`, and a public API reference at `/docs`. Two more public surfaces — login at `/login` and signup at `/signup` — are part of the auth flow rather than the marketing site, and the in-browser playground at `/playground` is documented in its own file. All five of those public-but-not-marketing pages still share the same top nav and footer, so visually they feel like one site.

The whole site needs to be fast, server-rendered, and SEO-friendly. There is no client-side state on any of these pages — the nav doesn't track a logged-in user (it always shows "Login" and "Get started"; logged-in users have the dashboard for everything). Each page sets its own page title and meta description, and the landing page emits Open Graph tags so it previews nicely in Slack, Twitter, and LinkedIn.

One non-obvious technical pin lives here: the entire frontend is built on Tailwind v3, not v4. The default `shadcn@latest init` flow emits CSS that targets v4 syntax (`ring-3`, `data-active:`, `outline-hidden`, etc.) which silently no-ops in v3 and produces invisible bugs where styles just don't apply. Every page on this site — and every page in the dashboard — relies on the v3-compatible variants. This is called out in this doc because the marketing pages are usually the first thing built and the first place the issue surfaces.

## UI/interaction idea

**Landing page (`/`).** A single-column layout with five sections stacked vertically. First, a hero with a tight one-line headline ("YouTube transcripts in one API call"), a slightly softer subhead explaining JSON / text / SRT / VTT support, two side-by-side buttons ("Get started" → signup, "View docs" → /docs), and a small visual on the right showing the API call and a snippet of returned JSON. Second, a three-up value-props row: "Native captions when available", "Whisper fallback when not", "Translation to 45+ languages", each with a small icon. Third, an embedded code sample showing the canonical `curl` invocation and the matching response — this is allowed to render inside a syntax-highlighted block because it's content the visitor needs to read, not implementation code. Fourth, a social proof placeholder strip ("Trusted by builders at" with a row of muted logo placeholders the user can swap in later). Fifth, a final CTA band before the footer ("Start building in two minutes" + "Get started" button).

**Pricing page (`/pricing`).** Four side-by-side pricing cards: Free, Starter, Pro, Business. Each card has a plan name, a one-line tagline, the monthly price, a "What you get" list (credits per month, max requests per minute, max video length, support tier), and a CTA button. The Free card's CTA reads "Sign up free" and links to signup. The paid plan CTAs also link to signup, where the user picks a plan after the account is created. Below the cards, a feature comparison table laid out vertically — feature name on the left, four columns of yes/no/values for the four plans. On mobile, the four cards stack vertically and the comparison table becomes a series of per-plan accordions.

**Public docs (`/docs`).** A long, single-page reference of the public REST API. Top of page: a paragraph introducing the base URL, the authentication scheme (`Authorization: Bearer yt_live_…`), and the general response envelope. Then one section per endpoint: name, HTTP verb and path, table of query parameters with type/required/default/description, table of response fields with types and descriptions, and a copy-pasteable `curl` example with a sample response below it. Endpoints documented are at minimum: `GET /v1/transcript`, plus auth helpers like signup/login as far as a third-party developer would need them. There's a sticky table of contents on the left so users can jump between sections.

**Shared chrome.** A top nav across all marketing/auth/playground pages: logo on the left, then "Pricing", "Docs", "Playground" as horizontal links, then "Login" and a primary "Get started" button on the right. On mobile the link cluster collapses into a hamburger that opens a slide-down sheet. A footer at the bottom of every page: three columns of links (Product / Resources / Legal), a copyright line, and a small wordmark. Both nav and footer are server components — they don't depend on any user state.

## Backend

### Schema

The marketing site is read-only. It does not own any tables. It reads, indirectly, two pieces of backend-owned data: the list of plans and their prices (rendered on the pricing page), and the OpenAPI surface (used to generate the docs page). For the MVP both of these are baked into the frontend as static constants so the marketing site can render without a backend round-trip; later they can be swapped to dynamic fetches if pricing changes need to ship without a frontend deploy.

### Endpoints

The site itself does not call any endpoints. The only "endpoint-shaped" content on the site is the curl examples in the docs page, which are illustrative — they document the public API the dashboard and playground actually exercise.

### Logic

There is no per-request server logic for these pages beyond Next.js's standard SSR. The pages render the same HTML for every visitor. If/when pricing becomes dynamic, fetching plans must happen at build time (using Next's static generation) so the page stays fast and SEO-friendly.

## Frontend

The site lives under `frontend/src/app/` with one folder per route: the root `page.tsx` for landing, `pricing/page.tsx`, and `docs/page.tsx`. Shared components — `SiteNav`, `SiteFooter`, the hero, value-prop card, pricing card, comparison table, doc-section block — live under `frontend/src/components/marketing/` so they can be reused across pages without polluting the dashboard component tree.

All three pages are server components. None of them need `"use client"`. The nav's mobile hamburger needs interactivity, so the hamburger button itself is a small client island inside the otherwise-server `SiteNav`.

Page-level metadata uses Next's `metadata` export on each route file: title (e.g. "Pricing — YouTube Transcripts API"), description (one sentence selling the page), and on the landing page, an `openGraph` block with a 1200×630 OG image, twitter card type, and the canonical URL.

The Tailwind v3 pin matters most here. When generating shadcn primitives for use on these pages (Button, Card, Badge, etc.), the `--base radix --preset nova` flags produce v4-syntax classes that need to be rewritten to v3 equivalents before they ship. The recurring offenders are: `ring-3` → `ring-2` plus `ring-offset-2`, `outline-hidden` → `outline-none`, `data-active:` → `data-[state=active]:`, and any use of `*:[…]:` child selector syntax which doesn't exist in v3. A short utility checklist lives in the project's `shadcn-tailwind-v3-fix` plan.

The site uses the same global font, color tokens, and spacing scale as the dashboard so transitioning from `/` into `/dashboard` after signup feels continuous, not like crossing into a different product.

The footer's "Playground" and "Docs" links must work whether or not the user is logged in — those pages do not require auth.

## Dependencies

- None. The marketing site is the entry point and depends on nothing else in this docs set.

The dashboard, transcript history, viewer, and playground all link back into the marketing site's nav (logo → home, footer links), so building the nav and footer here unlocks every other surface.

## Verification

- Load `/`, `/pricing`, and `/docs` while signed out. All three should render fully on first paint with no client-side hydration glitch (no "flash of unstyled content", no shifting layout).
- View page source on each: the `<title>` and `<meta name="description">` should reflect the page, not be a generic site-wide default.
- Run `next build` locally — it must complete with zero errors. A failing build blocks Vercel deploys.
- On mobile width (< 768 px) the top nav collapses to a hamburger that opens a working sheet; the pricing comparison table reflows into accordions.
- Inspect any shadcn-generated component on the page in DevTools and confirm no `ring-3`, no `outline-hidden`, no `data-active:`. If you see those, styles will silently fail in production.
- Curl the deployed landing page and confirm the OG meta tags are in the HTML: `curl -s https://<frontend>/ | grep -i 'og:'`.
- Click the "Docs" link in the footer; confirm it works whether you're logged in or signed out.
