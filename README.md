# Merge Desk

Internal merge control for Slashy's CTO: every open PR across the watched
repos, tied to the customer who reported it, with a one-click merge that only
lights up when the gates are green.

Live: **https://merge-desk.vercel.app**  
Repo: **https://github.com/tuanha1508/merge-desk**

Two actions per row: **Merge** and **View PR**. Nothing else.

## What it does

- **Queue** — open PRs across `GITHUB_REPOS`, newest activity on top, capped at
  50 and limited to the last 7 days of activity. Auto-polls every 3 minutes
  while the tab is visible (10 minutes when hidden).
- **Customer** — resolves a reachable contact for each PR: Linear CRM → ticket
  text → PostHog / Supabase by name or domain → ticket screenshots (name,
  email, or phone) when structured fields leave it unresolved. Ambiguous
  matches list every candidate as a live mailto. No customer found falls back
  to whoever filed the ticket.
- **Boss update** — a two-sentence, non-technical summary (under 45 words)
  grounded in the ticket and PR. Shown on every row, cached across refreshes
  in `localStorage`, and copyable from the detail view.
- **Merge gates** — CI must be green, and there must be no unresolved bot
  review threads. Re-checked server-side on every merge, for both the web UI
  and Slack. Merged rows slide off the board.
- **Slack** (optional) — one card per newly mergeable PR, with its own Merge
  button, confirmation, and the same boss update. See [`SLACK.md`](./SLACK.md).

## Run it

```bash
npm install
cp .env.example .env.local
# fill in tokens — see Config below
npm run dev
# http://localhost:3939
```

With no GitHub token / repos, it runs in **mock mode** (fake PRs) so the UX is
visible immediately. Merges in mock mode never touch GitHub.

## How a row is built

1. **List open PRs** — one GitHub GraphQL query per repo, ordered by
   `UPDATED_AT`, with CI rollup and review threads nested in the same request.
2. **Find the ticket** — parse a Linear ref (`SLA-####`) from branch, title, or
   body; fetch issue + linked customer in one Linear GraphQL query.
3. **Resolve the customer** (waterfall; never invents an address):
   - Linear customer `externalIds` / domains
   - email or name printed in the ticket body
   - PostHog by name, Supabase by domain / email
   - ticket screenshots (vision) only when the above leave it unresolved —
     customer-side contacts only; internal teammates are excluded
   - one confident hit → verified email; several → candidate list; none →
     ticket filer as fallback
4. **Gate the Merge button**:
   - CI green (`REQUIRE_GREEN_CI`)
   - no unresolved review threads authored by a blocking bot
5. **Merge** — squash (configurable). Gates are re-checked immediately before
   the GitHub call so a stale button cannot bypass them.

First paint loads the newest 5 rows; the rest fill in behind a "Polling more"
indicator. A short server-side cache (45s) keeps subsequent polls cheap.

## Config

See [`.env.example`](./.env.example). Minimum to go live:

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Repo + merge access. Locally falls back to `gh auth token`. |
| `GITHUB_REPOS` | Comma-separated `owner/repo` allowlist. |
| `MQ_PASSWORD` | Shared sign-in password. **Required in production.** |
| `LINEAR_API_KEY` | Ticket + customer lookup. |
| `SUPABASE_*` / `POSTHOG_*` | Email resolution backends. |
| `ANTHROPIC_API_KEY` | Boss updates + screenshot contact extraction. |
| `OWN_EMAIL_DOMAINS` | e.g. `slashy.com,slashy.ai` — never treated as customers. |
| `OWN_COMPANY_NAMES` | e.g. `Slashy` — same filter for display names. |

Slack vars are documented in [`SLACK.md`](./SLACK.md) and left empty until
that integration is turned on.

## Signing in

Set `MQ_PASSWORD` before deploying anywhere reachable. Everyone who needs the
desk shares it; signing in stores a signed, HttpOnly cookie for 14 days.

Leaving it empty keeps local development frictionless, but a **production
build with no password refuses to serve** — redirects to `/login`, APIs return
401, `/api/login` returns 503 — so a half-configured deploy is inert rather
than wide open. That matters because this surface lists customer emails and
can squash-merge `main`.

Scripts can skip the form by sending a token from `MQ_ACCESS_TOKENS` as
`x-mq-token`. Slack routes are exempt: interactivity is verified against
`SLACK_SIGNING_SECRET`, publishing against `SLACK_PUBLISH_SECRET`.

Failed sign-ins lock after 5 attempts from the same IP for 15 minutes
(process-local on serverless — put a Vercel Firewall rate limit on
`/api/login` in production). Merges are limited to repos in `GITHUB_REPOS` on
both the web and Slack paths.

## Deploy

Hosted on Vercel as project `merge-desk`, connected to this repo's `main`
branch. Pushes auto-deploy. Env vars live in the Vercel project (not in git).

```bash
# one-off production deploy from a laptop
vercel deploy --prod
```

## Stack

Next.js 16 (App Router) + React 19 + Tailwind v4. No database. Integrations
are plain `fetch`. Auth is an HMAC-signed cookie verified at the edge
(`src/proxy.ts`) and again in Node for API routes.

## Product principles

1. Answer "can I merge this right now" before anything else.
2. Re-check gates server-side on every merge — never trust a stale button.
3. Customer identity is a first-class column, not buried in a drawer.
4. Anything the user will paste elsewhere (update, email) is one click away.
5. Missing data is stated plainly; never invented.
6. Generated text is forwarded as fact, so it may only assert what the material
   evidences.
