# Slack setup

The integration posts one message per mergeable pull request. Every message has
its own `Merge #123` button and native Slack confirmation. A click re-checks CI
and unresolved bot reviews server-side, then merges only that repo/PR pair.

Each card leads with the customer's problem and carries the same two-sentence,
non-technical boss update the web detail shows, so it can be read - or
forwarded - without opening anything. The update needs `ANTHROPIC_API_KEY`; a
card without one still posts and still merges.

## 1. Create the Slack app

Create an app at <https://api.slack.com/apps> in the Slashy workspace and add
these **Bot Token Scopes**:

- `chat:write` — post cards, update them after a click, and send the private
  error notes that go only to the person who clicked
- `channels:history` — a public `#merge-control` channel
- `groups:history` — instead, if the target channel is private
- `im:write` and `im:history` — instead, if cards are delivered by DM

History is required, not optional: publishing reads the recent conversation to
decide which PRs already have a card, and without it every run would repost the
whole queue.

Install the app to the workspace. Copy the **Bot User OAuth Token** and
**Signing Secret** into the deployment environment:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

## 2. Configure interactions

Under **Interactivity & Shortcuts**, enable interactivity and use:

```text
https://YOUR_DEPLOYMENT/api/slack/events
```

Chat SDK verifies Slack's signature and timestamp before any action handler is
run.

## 3. Choose where cards go

For a channel, invite the app to the channel and set its channel ID:

```dotenv
SLACK_CHANNEL_ID=C0123456789
```

For a direct message instead, omit `SLACK_CHANNEL_ID` and set:

```dotenv
SLACK_TARGET_USER_ID=U0123456789
```

Slack IDs are available from **Copy link** / **View profile → Copy member ID**.

## 4. Allow mergers

Merging is denied to everyone unless their Slack member ID is explicitly
listed:

```dotenv
SLACK_MERGE_USER_IDS=U_BOSS_ID,U_YOUR_ID
```

## 5. Enable publishing

Set one strong random secret:

```dotenv
SLACK_PUBLISH_SECRET=...
```

Publishing needs a schedule. The deployment ships without one, so add a
`vercel.json` at the app root when you turn Slack on:

```json
{ "crons": [{ "path": "/api/slack/publish", "schedule": "*/10 * * * *" }] }
```

Hobby projects only allow one cron a day, so a ten-minute schedule needs a Pro
plan. On Vercel, setting `CRON_SECRET` instead of `SLACK_PUBLISH_SECRET` also
works and causes Vercel Cron to send the required bearer token automatically.

To test publishing manually:

```bash
curl -X POST https://YOUR_DEPLOYMENT/api/slack/publish \
  -H "Authorization: Bearer $SLACK_PUBLISH_SECRET"
```

Publishing reads recent messages in the target conversation, posts only newly
ready PRs, and retires cards whose PR is no longer mergeable. Clicking a stale
card is still safe because gates are checked again immediately before merge.

Boss updates are generated only for the cards being posted, a few at a time, so
a cycle with nothing new does no model work. A card keeps the update it was
posted with; it is not regenerated on later cycles.

## 6. Check the cards before aiming this at anyone

`?dry=1` returns exactly what would be posted, built from the live queue,
without a Slack token and without sending anything:

```bash
curl -s -X POST "http://localhost:3939/api/slack/publish?dry=1" \
  -H "x-slack-publish-secret: $SLACK_PUBLISH_SECRET" | jq
```

Paste any card's `blocks` into <https://app.slack.com/block-kit-builder> to see
it rendered by Slack itself. Worth confirming on the real payload: each card
carries exactly one `merge_pr` button, and its `value` is that card's own
`owner/repo#number`. That pairing is the whole reason a click cannot merge
anything other than the PR being looked at.

## What a card does over its life

| State | Trigger | Card |
| --- | --- | --- |
| Ready | published | problem, customer, boss update, `Merge #123`, `Open PR` |
| Merging | button clicked | buttons replaced by `Merging · Requested by @user` |
| Merged | GitHub merged it | buttons replaced by `Merged · Merged successfully` |
| Merge blocked | gates failed at click time | reason on the card, plus a private note to the clicker |
| No longer ready | a later publish sees it left the queue | `No longer ready`, no buttons |

The buttons are removed *before* GitHub is called, so a second impatient click
has nothing to press and cannot start a second merge of the same PR. A card
whose buttons are already gone answers a click with a private "already handled"
note instead of acting on it.
