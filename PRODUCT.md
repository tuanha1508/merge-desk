# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user is the CTO at Slashy, who has roughly ten engineers reporting to him. He opens this between other work, usually to answer "what is waiting on me, and is it safe to merge?" He is technical and reads code, but when a fix ships he also has to tell non-technical people what happened and reach the customer who reported it.

Secondary users are the engineers themselves, checking whether their own PR is clear to merge and which gate is holding it.

## Product Purpose

One screen that collects every open pull request across the Slashy repos, shows whether each is actually safe to merge, ties it to the customer who reported the problem, and merges it in one click. Success is the CTO clearing the queue without opening GitHub, Linear, Supabase, or PostHog in separate tabs.

## Positioning

GitHub shows pull requests; Linear shows tickets; the customer's email lives in neither. This joins all three: a PR carries its Linear ticket, the ticket resolves to a named customer with a reachable email address, and the merge button only lights up when the gates are genuinely green. The email resolution waterfall is the part a neighboring tool cannot copy, because it runs against Slashy's own Supabase and PostHog.

## Operating Context

- Repos watched: `Slashy-com/slashyemail` and `Slashy-com/slashy-backend`.
- Tickets live in Linear, referenced from the PR branch name, title, or body as `SLA-####`.
- Bot review comes from automated reviewers on the PR; unresolved bot threads are the most common reason a PR is not mergeable.
- After merging, the user often needs to send two things: a short non-technical update to leadership, and an email to the customer who reported it.
- Used on a desktop browser, in a normal indoor work session, alongside the Slashy mail app itself.

## Capabilities and Constraints

- Lists PRs active in the last seven days across the configured repos, capped
  at 50 total to keep polling bounded.
- Merge gates, both enforced again on the server before any merge executes: every required check passing, and zero unresolved bot review threads.
- Merge method is squash.
- A Slack app publishes one message per newly mergeable PR to a configured
  channel or CTO DM. Each message merges only its own repo/PR pair, requires a
  native confirmation, restricts merging to allowlisted Slack users, and uses
  the same server-side gate re-check as the web UI. A card leads with the
  customer's problem, as the queue does, carries the same two-sentence boss
  update, and loses its buttons the moment it is acted on so it can never be
  merged twice. The update is generated only for newly posted cards and is
  best-effort, so a card without it still posts and still merges.
- Customer email resolution runs as a waterfall: Linear customer records first, then Supabase users, then PostHog persons. It returns either one verified address, several candidates needing confirmation, or nothing.
- A two-sentence, non-technical, under-45-word summary is generated per ticket on demand (not for the whole list) and is meant to be copied and pasted as-is. It is grounded in the PR description and changed paths as well as the ticket, and is forbidden from claiming work that material does not evidence. When the PR does not address its linked ticket, the summary says so rather than describing a fix that never shipped.
- Ticket bodies are markdown and frequently include screenshots and video, served through an authenticated Linear asset proxy.
- Email resolution never gates merging; a PR with no customer found is still mergeable.

## Brand Commitments

- The design system is Slashy's own, from `slashyemail/src/index.css`. Binding tokens: background `#191919`, surface `#202020`, divider `#262626`, text `#D3D3D3` / `#9B9B9B` / `#7F7F7F`, accent `#2383E2`, success `#34D399`, destructive `#DE5550`, warning `#FBBF24`. Light mode equivalents exist in the same file.
- Brand mark indigo is `#4457C4` (light) / `#7C8AF0` (dark).
- Type is the system stack (`-apple-system`), 14px/20px as the base row size, radii 4/6/8/12px.
- User-pinned for this surface: a modern, rounded treatment. Explicitly rejected: dense hairline-rule tables, all-caps tracked labels, editorial/broadsheet styling.

## Evidence on Hand

- Working app in this repository, live at https://merge-desk.vercel.app against
  real GitHub, Linear, Supabase, and PostHog credentials in `.env.local`.
- Real ticket and customer data observed during development, including `SLA-6904` (dark mode rendering) and `SLA-6794`.
- `src/lib/mock.ts` provides fallback data when credentials are absent.
- No pricing, customer count, SLA guarantee, or performance benchmark has been established; none may be invented.

## Product Principles

1. The queue answers "can I merge this right now" before it answers anything else.
2. Never let the tool merge something the gates would refuse; re-check server-side every time.
3. Customer identity is a first-class column, not a detail buried in a drawer.
4. Anything the user will paste elsewhere (the update, the email address) must be copyable in one action.
5. Missing data is stated plainly rather than hidden or faked.
6. Generated text is forwarded to an executive as fact, so it may only assert what the underlying material evidences. A shorter honest update beats a fuller confident one.
