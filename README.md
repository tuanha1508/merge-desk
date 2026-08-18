# Merge Desk

A merge-control desk for a CTO: every open PR across watched repos, tied to the
customer who reported it, with a one-click merge that only lights up when the
gates are green.

Repo: **https://github.com/tuanha1508/merge-desk**

Two actions per row: **Merge** and **View PR**. Nothing else.

<p align="center">
  <img src="docs/screenshots/inbox.png" alt="Merge Desk inbox in mock mode" width="900" />
</p>

<p align="center">
  <img src="docs/screenshots/detail.png" alt="PR detail with boss update and gates" width="720" />
  &nbsp;
  <img src="docs/screenshots/blocked.png" alt="PR blocked by a fake Claude bot review" width="720" />
</p>

> **Try it without credentials.** `npm install && npm run dev` runs in mock
> mode with invented customers, tickets, and a fake Claude bot review. Merges
> never touch GitHub. The production deploy (if any) stays password-gated and
> is not part of the public demo.

## What it does

- **Queue** — open PRs across `GITHUB_REPOS`, newest activity on top, capped at
  50 and limited to the last 7 days of activity. Updates live over Supabase
  Realtime the instant a webhook or merge changes it, and auto-polls every 3
  minutes (10 when hidden) as a safety net.
- **Customer** — resolves a reachable contact for each PR: Linear CRM → ticket
  text → PostHog / Supabase by name or domain → ticket screenshots (name,
  email, or phone) when structured fields leave it unresolved. Ambiguous
  matches list every candidate as a live mailto. No customer found falls back
  to whoever filed the ticket.
- **Boss update** — a two-sentence, non-technical summary (under 45 words)
  grounded in the ticket and PR. Shown on every row, cached across refreshes
  in `localStorage` and Supabase, and copyable from the detail view.
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
# run supabase/migrations/20260819032000_merge_desk_cache.sql once
npm run dev
# http://localhost:3939
```

With no GitHub token / repos, it runs in **mock mode** (fake PRs) so the UX is
visible immediately. Merges in mock mode never touch GitHub.

## Public repo notes

- `.env` / `.env.local` are gitignored. Never commit real tokens.
- Mock data in `src/lib/mock.ts` is invented on purpose (Northwind, Globex,
  Contoso, a fake `claude[bot]` review) so screenshots and clones stay safe.
- A live deploy with real customer emails should stay private / password-gated;
  this repository is the portfolio surface, not the production data plane.

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
indicator. A 45-second memory cache sits in front of a shared Supabase snapshot,
so cold Vercel instances render without repeating GitHub, Linear, and customer
lookups. Webhooks patch that snapshot directly; a full reconciliation every 15
minutes repairs missed deliveries.

When a webhook or merge changes the queue, the server broadcasts a small
data-free ping on a Supabase Realtime channel and every open board refreshes
within a second — no waiting for the next poll. Set `NEXT_PUBLIC_SUPABASE_URL`
and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to enable it; leave them blank to fall back
to polling only. The anon key is safe in the browser: the ping carries no PR
data, and row-level security keeps that key out of every table.

Queue rows and generated summaries expire after 7 days. Closed or merged PRs
are deleted immediately, and expired rows are cleaned daily. The migration
enables RLS, grants access only to the service role, and uses a sync marker so
the five-row first paint can never be mistaken for the complete queue.

## Connect your data

Merge Desk is a shell that joins your own tools together — it ships with **no
data of its own**. Out of the box it runs in mock mode; to point it at real
work, connect the services below. Each one is optional except GitHub, and the
app degrades gracefully when a connection is missing (a PR with no ticket still
lists and still merges; a PR with no resolved customer falls back to whoever
filed it).

Copy [`.env.example`](./.env.example) to `.env.local` and fill in what you have.

### 1. GitHub — required

The only connection you actually need. Without it the app stays in mock mode.

- `GITHUB_TOKEN` — a token (classic or fine-grained) with `repo` scope so it can
  read PRs, CI status, review threads, and perform the squash merge. Locally it
  falls back to `gh auth token`; on a server you must set it explicitly.
- `GITHUB_REPOS` — comma-separated `owner/repo` allowlist. This is also the
  merge allowlist: the app will refuse to merge anything outside it.
- `GITHUB_WEBHOOK_SECRET` — optional but recommended. Add a webhook in each repo
  pointing at `/api/github/webhook` (events: pull request, check run, review
  thread) so the board updates the instant a PR moves instead of on the poll.

### 2. Linear — tickets & customers (optional)

Turns a PR into "who reported this and why". Skip it and rows just show the PR
title with no ticket or customer.

- `LINEAR_API_KEY` — reads the issue referenced from the PR branch/title/body
  (default pattern `SLA-####`, adjust in `src/lib/linear.ts`) plus any linked
  Linear **customer** record.

### 3. Customer lookup — Supabase & PostHog (optional)

Used to turn a name in a ticket into a **reachable email**, when Linear alone
can't. This is the part you tailor to your own backend — the queries in
`src/lib/supabase.ts` and `src/lib/posthog.ts` assume a users table and a
persons index; edit them to match your schema.

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — connect your product's user database.
  `SUPABASE_USERS_TABLE` / `SUPABASE_EMAIL_COLUMN` name the table and email
  column to search.
- `POSTHOG_HOST`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` — look up a
  person by name when they aren't in your DB yet.

Supabase does double duty: if configured, it also stores the shared **7-day
queue + summary cache** and powers live updates (below). Run the migration in
`supabase/migrations/` once to create those tables.

### 4. Boss updates — Anthropic (optional)

- `ANTHROPIC_API_KEY` — generates the two-sentence, non-technical summary per
  ticket and reads customer contacts out of ticket screenshots. Skip it and the
  update section simply stays empty.
- `ANTHROPIC_MODEL` — defaults to a Haiku model; override to trade cost/quality.

### 5. Live updates — Supabase Realtime (optional)

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — let the browser
  subscribe to a broadcast channel so the board refreshes within a second of a
  change. The anon key is safe to expose: the ping carries no PR data and RLS
  keeps that key out of every table. Leave blank to fall back to polling.

### 6. Access control — always set before deploying

- `MQ_PASSWORD` — shared sign-in password. **A production build with no password
  refuses to serve.** This surface lists customer emails and can merge `main`.
- `MQ_ACCESS_TOKENS` — optional machine tokens for scripts (`x-mq-token` header).
- `OWN_EMAIL_DOMAINS` / `OWN_COMPANY_NAMES` — your own domains and names, so your
  teammates are never mistaken for the customer being helped.

### 7. Slack (optional)

One card per newly mergeable PR, each with its own Merge button. See
[`SLACK.md`](./SLACK.md); all `SLACK_*` vars stay empty until you turn it on.

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

Next.js 16 (App Router) + React 19 + Tailwind v4 + Supabase Postgres.
Integrations use plain `fetch` through server-only routes. Auth is an
HMAC-signed cookie verified at the edge (`src/proxy.ts`) and again in Node for
API routes.

## Product principles

1. Answer "can I merge this right now" before anything else.
2. Re-check gates server-side on every merge — never trust a stale button.
3. Customer identity is a first-class column, not buried in a drawer.
4. Anything the user will paste elsewhere (update, email) is one click away.
5. Missing data is stated plainly; never invented.
6. Generated text is forwarded as fact, so it may only assert what the material
   evidences.
