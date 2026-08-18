# Merge Desk

Internal tool for the CTO: list open PRs across repos, show the **customer email**
and a one-line **ticket problem**, and **one-click Merge** — but only when CI is
green and there are **no unresolved bot review threads**.

Two actions per row: **Merge** and **View PR**. Nothing else.

## Run it

```bash
npm install
npm run dev
# http://localhost:3939
```

With no `.env`, it runs in **mock mode** (fake PRs) so you can see the exact UX
immediately. Copy `.env.example` to `.env` and fill in tokens to go live.

## How a row is built

1. **List open PRs** — GitHub REST per repo in `GITHUB_REPOS`.
2. **Find the ticket** — parse a Linear ref (e.g. `ENG-123`) from branch/title/body,
   fetch title + description from Linear.
3. **Resolve customer email** (waterfall, first solid hit wins):
   - email or name printed in the ticket / Linear `Customer` label
   - → **Supabase** lookup by name
   - → **PostHog** lookup by name
   - ambiguous → show candidates, engineer picks
   - never invents an unseen address
4. **Gate the Merge button**:
   - CI must be green (`REQUIRE_GREEN_CI`)
   - no **unresolved review threads authored by a bot** (GitHub GraphQL `reviewThreads`)
   - blocking bots configurable via `BLOCKING_BOTS`
5. **Merge** — GitHub merge API, method from `GITHUB_MERGE_METHOD` (default squash).
   The gate is re-checked server-side so the button can't bypass it.

## Config

See `.env.example`. Minimum to go live: `GITHUB_TOKEN` + `GITHUB_REPOS`.
Add `LINEAR_API_KEY`, `SUPABASE_*`, `POSTHOG_*` to enrich customer/email.

## Signing in

Set `MQ_PASSWORD` before deploying anywhere reachable. Everyone who needs the
queue shares it; signing in stores a signed, HttpOnly cookie for 14 days.

Leaving it empty keeps local development frictionless, but a **production build
with no password refuses to serve** — the queue redirects to `/login`, the API
returns 401, and `/api/login` returns 503, so a half-configured deploy is inert
rather than wide open. That matters because this surface lists customers' email
addresses and can squash-merge `main`.

Scripts can skip the sign-in form by sending a token from `MQ_ACCESS_TOKENS` as
`x-mq-token`. Slack's two routes are exempt: interactivity payloads are verified
against `SLACK_SIGNING_SECRET`, and publishing carries `SLACK_PUBLISH_SECRET`.

Failed sign-ins are locked after 5 attempts from the same IP for 15 minutes
(process-local on serverless, so also put a Vercel Firewall rate limit on
`/api/login` in production). Merges are limited to repos listed in
`GITHUB_REPOS` on both the web and Slack paths.

## Stack

Next.js 16 (App Router) + React 19 + Tailwind v4. No database. All integrations
are plain `fetch`, so there's nothing heavy to install or maintain.

## Notes / decisions

- Customer resolution is a fallback chain, not a single field — Linear first,
  then backend lookups, because the `Customer` field is often empty.
- "No unresolved bot review" uses GraphQL review threads (REST comments don't
  carry resolved state).
- Slack/CLI were considered; a web table wins because the CTO wants to scan a
  wide, multi-column queue and merge in place.
