# Design

The source of truth for this interface is the Paper file **Merge Queue**
(`https://app.paper.design/file/01M06X8V1P7VGQ4F1NTJ2YK7PZ/1-0`), artboards
`Merge Queue — Inbox` and `PR detail — opened`. The build is a direct
translation of those two artboards. When the code and the Paper file disagree,
the Paper file wins.

## Tokens

Lifted verbatim from the Paper file's token set, with matching names, into
`src/app/globals.css` under Tailwind's `@theme`.

| Token | Value | Role |
| --- | --- | --- |
| `--color-bg` | `#191919` | page ground |
| `--color-surface-2` | `#202020` | left rail, active rows, cards |
| `--color-surface` | `#2D2D2D` | reserved |
| `--color-rule` | `#262626` | table borders |
| `--color-rule-strong` | `rgb(255 255 255 / 13%)` | dividers, scrollbar |
| `--color-text` | `#D3D3D3` | primary |
| `--color-text-2` | `#9B9B9B` | secondary |
| `--color-text-faint` | `#7F7F7F` | tertiary |
| `--color-accent` | `#2383E2` | merge, links, ticket ids |
| `--color-accent-dim` | `rgb(51 146 221 / 15%)` | status pill |
| `--color-accent-wash` | `rgb(51 146 221 / 10%)` | boss-update card |
| `--color-pass` | `#34D399` | checks passed |
| `--color-fail` | `#DE5550` | checks failing |
| `--color-warn` | `#FBBF24` | review comments open |

Two translucent surfaces carry the file's control and quiet-row treatments:
`--color-control` (`#FFFFFF0F`) for pills, tabs, and secondary buttons, and
`--color-quiet` (`#FFFFFF06`) for rows that are not yet mergeable.

## Type

System sans (`-apple-system` resolves to SF Pro Text, the file's family).
Sizes are absolute, matching the artboards: 22/28 at `-0.02em` for the page
title, 24/31 at `-0.02em` for the detail title, 16/22 at `-0.01em` for section
headings, 16/26 for the boss update, 15/25 for ticket prose, 14/20 for row
identity and controls, 13/20 for status and metadata. Counts use tabular
numerals so rail and tab figures hold their lane.

## Layout

**Inbox.** A 220px rail on `surface-2` holding readiness counts and repos, then
a fluid column with 28px top / 28px left / 32px right padding and a 22px stack
gap. Inside: title with `Updated …` and Refresh, an author tab strip, a 6px-gap
group of mergeable rows on `surface-2`, then a `Waiting on checks or review`
heading and its rows on `quiet`.

**Row.** 12px radius, 14px/16px padding. Customer name and email lead; the
one-line problem sits beneath. A fixed 190px right-aligned lane carries the
status so icons and words align across rows regardless of content. `View PR`
and `Merge` close every row — merging never requires opening the detail.

**Detail.** Centred at 860px. A bar with back, status pill, `View on GitHub`
and `Merge`; then title, `repo · Pull request N · ticket`, the customer card,
the boss update, the reported problem, and the `Before it merges` gates.

## Interaction

Tailwind v4 resets buttons to `cursor: default`, so `globals.css` restores
`pointer` on every button, `[role="button"]`, and link, and sets `not-allowed`
on anything disabled — a blocked Merge says so through the cursor as well as
its colour.

A refresh re-runs every GitHub and Linear call, which takes seconds rather than
milliseconds, so it reports its flight: `router.refresh()` runs inside a React
transition, the button disables and spins, the status line reads `Checking
GitHub and Linear…`, and the timestamp only moves once the new payload has
landed. `Search again` on an unresolved customer uses the same transition.
The page also sets `overscroll-behavior-y: none` so the queue does not
rubber-band past its end.

Rows lift on hover (`#202020` → `#262626`, and `quiet` → `control` for rows
that cannot merge yet) and the problem line brightens to primary text, so the
whole row reads as one target. Buttons take a 0.97 press scale; Merge shifts to
`#3A92E8` rather than a brightness filter, keeping it on the token ramp. Repo
entries in the rail are static text and deliberately have no hover, because
they do not filter.

## Check states

CI is a tri-state (`passing` / `pending` / `failing`), not a boolean, so a
check that is still running never renders as a failure. Rows show `Checks
running` in neutral text; only genuine failure conclusions
(`failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure`,
`stale`) turn red.

## Divergences from the artboards

The artboards specify one desktop width and a single static state. These are
the only places the build adds to them, each noted with its reason:

- **Detail bar is sticky.** The artboard is one tall frame; in a scrolling
  window the Merge button would leave the viewport on a long ticket.
- **Rows stack below 768px.** The 190px status lane and both buttons cannot fit
  a phone width. Above 768px the row is pixel-identical to the artboard.
- **Author tabs scroll horizontally** when the team is wider than the column.
- **Identity falls back.** The artboard shows a name and an email; when only an
  email resolves it becomes the primary line, and when neither resolves the row
  reads `No customer found` with `Search again`, as the artboard's third row does.
- **No identity avatar.** The artboard's initial-in-a-circle carries no
  information the name beside it does not, and a generated initial reads as a
  real account picture. The name and email start the card instead.
- **PR context is chipped.** The artboard sets repo, number and ticket as faint
  inline text under the title. At `--color-text-faint` on the page ground the
  labels read as decoration, and these are the identifiers most often looked
  for, so each fact sits on a raised chip with its label above its value.

`--color-text-faint` (`#7F7F7F`) measures 4.3:1 on the page ground, just under
the 4.5:1 floor. It ships as specified because it is the design system's own
value; raising it to `#8E8E8E` would clear the floor if that is preferred.
