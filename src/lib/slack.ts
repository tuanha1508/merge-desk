import { Chat } from "chat";
import {
  createSlackAdapter,
  type SlackAdapter,
} from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Block, KnownBlock } from "@slack/types";
import { config } from "./config";
import { authorName, displayTitle, headline } from "./display";
import { getPullRequestContext } from "./github";
import { mergeQueueItem } from "./merge";
import { getQueue } from "./queue";
import { summarizeForBoss } from "./summarize";
import type { QueueItem } from "./types";

const MERGE_ACTION = "merge_pr";
const READY_PREFIX = "Ready to merge: ";

type SlackBlock = Block | KnownBlock;

interface SlackActionPayload {
  channel?: { id?: string };
  message?: { ts?: string; blocks?: unknown[] };
  user?: { id?: string };
}

interface SlackHistoryMessage {
  blocks?: unknown[];
  text?: string;
  ts?: string;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function plain(value: string): string {
  return value.replace(/[<>&]/g, (char) => {
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&amp;";
  });
}

function contactLine(item: QueueItem): string {
  const customer = [item.customer.name, item.customer.email]
    .filter(Boolean)
    .join(" · ");
  if (customer) return customer;

  const filer = [item.ticket?.filedBy?.name, item.ticket?.filedBy?.email]
    .filter(Boolean)
    .join(" · ");
  return filer ? `${filer} · filed the ticket` : "No customer found";
}

function readyBlocks(item: QueueItem, summary?: string | null): SlackBlock[] {
  const repoName = item.repo.split("/").at(-1) ?? item.repo;
  const blocks: SlackBlock[] = [
    /*
      The customer's problem leads, exactly as it does in the web queue. The
      commit subject is deliberately the second line: the reader is deciding
      whose issue gets fixed, not reviewing the diff.
    */
    {
      type: "header",
      text: {
        type: "plain_text",
        text: clip(headline(item), 145),
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${plain(contactLine(item))}*\n${plain(clip(displayTitle(item), 500))}`,
      },
    },
  ];

  /*
    The two-sentence boss update is the whole reason this reader exists, so it
    goes on the card as a blockquote - the same text the web detail shows,
    copy-ready. It is best-effort: a card without it still merges.
  */
  if (summary) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `>${plain(clip(summary, 600)).replace(/\n/g, "\n>")}`,
      },
    });
  }

  blocks.push(
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Ready to merge*  ·  ${plain(repoName)}  ·  PR #${item.number}  ·  opened by ${plain(authorName(item.author))}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: MERGE_ACTION,
          text: {
            type: "plain_text",
            text: `Merge #${item.number}`,
            emoji: true,
          },
          style: "primary",
          value: item.id,
          confirm: {
            title: { type: "plain_text", text: `Merge #${item.number}?` },
            text: {
              type: "mrkdwn",
              text: `Merge *${plain(repoName)} #${item.number}*?\n\nCI and unresolved bot reviews will be checked again first.`,
            },
            confirm: { type: "plain_text", text: `Merge #${item.number}` },
            deny: { type: "plain_text", text: "Cancel" },
            style: "primary",
          },
        },
        {
          type: "button",
          action_id: "open_pr",
          text: { type: "plain_text", text: "Open PR", emoji: true },
          url: item.url,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: item.ticket?.url
            ? `<${item.ticket.url}|${item.ticket.id}> · Last active ${new Date(item.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
            : `Last active ${new Date(item.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
        },
      ],
    },
  );

  return blocks;
}

const STATE_LABELS = {
  merging: "Merging",
  merged: "Merged",
  blocked: "Merge blocked",
  stale: "No longer ready",
} as const;

type CardState = keyof typeof STATE_LABELS;

/**
 * A card that has been acted on keeps everything except its buttons, so the
 * channel still reads as a record of which customer's fix went out. Used as a
 * fallback when the original blocks are not available.
 */
function finalBlocks(
  label: string,
  state: CardState,
  detail: string,
): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${STATE_LABELS[state]} · ${plain(label)}*\n${plain(detail)}`,
      },
    },
  ];
}

function isActions(block: unknown): boolean {
  return (block as { type?: string } | null)?.type === "actions";
}

/**
 * Swaps the button row for a status line, leaving the rest of the card intact.
 * Removing the buttons is what takes the card out of play - a merged PR must
 * not keep offering a Merge button to the next person who scrolls past it.
 */
function withStatus(
  original: unknown[] | undefined,
  state: CardState,
  detail: string,
): SlackBlock[] {
  const blocks = (original ?? []) as SlackBlock[];
  if (!blocks.some(isActions)) return [];

  const status: SlackBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${STATE_LABELS[state]}*  ·  ${plain(detail)}`,
    },
  };
  return blocks.map((block) => (isActions(block) ? status : block));
}

export function splitPrRef(value: string): [string, number] | null {
  const separator = value.lastIndexOf("#");
  if (separator <= 0) return null;
  const repo = value.slice(0, separator);
  const number = Number(value.slice(separator + 1));
  if (!config.repos.includes(repo) || !Number.isInteger(number) || number <= 0) {
    return null;
  }
  return [repo, number];
}

function slackUserAllowed(userId: string): boolean {
  return config.slackMergeUserIds.includes(userId);
}

/**
 * Failures are told to the person who clicked and nobody else, so a blocked
 * merge does not read like an announcement. Ephemeral posts are not delivered
 * in every conversation type, so a DM is the fallback.
 */
async function postPrivateError(
  slack: SlackAdapter,
  channel: string | undefined,
  user: string,
  text: string,
) {
  if (channel) {
    try {
      await slack.webClient.chat.postEphemeral({ channel, user, text });
      return;
    } catch {
      // Fall through to a direct message.
    }
  }
  try {
    await slack.webClient.chat.postMessage({ channel: user, text });
  } catch {
    // Nothing left to try; the click is simply unacknowledged.
  }
}

function createSlackBot() {
  if (!config.slackBotToken || !config.slackSigningSecret) {
    throw new Error("Slack bot token and signing secret are not configured.");
  }

  const adapter = createSlackAdapter({
    botToken: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
  });
  const bot = new Chat({
    userName: "merge-control",
    adapters: { slack: adapter },
    state: createMemoryState(),
    logger: "warn",
  });

  bot.onAction(MERGE_ACTION, async (event) => {
    const raw = event.raw as SlackActionPayload;
    const channel = raw.channel?.id;
    const messageTs = raw.message?.ts ?? event.messageId;
    const userId = raw.user?.id ?? event.user.userId;
    const slack = event.adapter as SlackAdapter;

    if (!slackUserAllowed(userId)) {
      await postPrivateError(
        slack,
        channel,
        userId,
        "You are not allowed to merge pull requests from this Slack app.",
      );
      return;
    }

    const ref = splitPrRef(event.value ?? "");
    if (!ref || !channel || !messageTs) {
      await postPrivateError(
        slack,
        channel,
        userId,
        "This merge button is invalid. Open Merge Control and try again.",
      );
      return;
    }

    const [repo, number] = ref;
    const label = `${repo.split("/").at(-1) ?? repo} #${number}`;
    const original = raw.message?.blocks;

    /*
      The buttons are taken away before GitHub is called, not after. A merge
      takes a few seconds, and without this the card still looks actionable -
      an impatient second click would fire a second merge of the same PR.
    */
    const claimed = withStatus(
      original,
      "merging",
      `Requested by <@${userId}>`,
    );
    if (claimed.length === 0) {
      await postPrivateError(
        slack,
        channel,
        userId,
        `${label} has already been handled - its card is no longer actionable.`,
      );
      return;
    }

    await slack.webClient.chat.update({
      channel,
      ts: messageTs,
      text: `Merging: ${repo}#${number}`,
      blocks: claimed,
    });

    const settle = async (state: CardState, detail: string) => {
      const blocks = withStatus(original, state, detail);
      await slack.webClient.chat.update({
        channel,
        ts: messageTs,
        text: `${STATE_LABELS[state]}: ${repo}#${number}`,
        blocks:
          blocks.length > 0 ? blocks : finalBlocks(label, state, detail),
      });
    };

    try {
      const { result } = await mergeQueueItem(repo, number);
      await settle(result.merged ? "merged" : "blocked", result.message);
      if (!result.merged) {
        // The card carries the reason, but the person who clicked should not
        // have to re-read it to learn their click did nothing.
        await postPrivateError(
          slack,
          channel,
          userId,
          `${label} was not merged: ${result.message}`,
        );
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Merge failed unexpectedly.";
      await settle("blocked", detail);
      await postPrivateError(slack, channel, userId, `${label}: ${detail}`);
    }
  });

  return bot;
}

let botInstance: ReturnType<typeof createSlackBot> | null = null;

export function getSlackBot() {
  botInstance ??= createSlackBot();
  return botInstance;
}

/** `owner/repo#123` as the short `repo #123` a human reads. */
function prLabel(itemId: string): string {
  const at = itemId.lastIndexOf("#");
  if (at <= 0) return itemId;
  const repo = itemId.slice(0, at).split("/").at(-1) ?? itemId.slice(0, at);
  return `${repo} #${itemId.slice(at + 1)}`;
}

async function targetChannel(slack: SlackAdapter): Promise<string> {
  if (config.slackChannelId) return config.slackChannelId;
  if (!config.slackTargetUserId) {
    throw new Error(
      "Set SLACK_CHANNEL_ID or SLACK_TARGET_USER_ID before publishing.",
    );
  }

  const opened = await slack.webClient.conversations.open({
    users: config.slackTargetUserId,
  });
  const channel = opened.channel?.id;
  if (!channel) throw new Error("Slack did not return a DM channel.");
  return channel;
}

function readyId(message: SlackHistoryMessage): string | null {
  if (!message.text?.startsWith(READY_PREFIX)) return null;
  return message.text.slice(READY_PREFIX.length);
}

export interface SlackCard {
  id: string;
  text: string;
  blocks: SlackBlock[];
}

/**
 * The boss update for one card, using the same evidence path as the web route:
 * the PR body and touched paths are read from GitHub, never trusted from
 * elsewhere. Best-effort - any failure yields a card without the summary.
 */
async function bossUpdateFor(item: QueueItem): Promise<string | null> {
  try {
    let prBody = "";
    let changedFiles: string[] = [];
    try {
      const ctx = await getPullRequestContext(item.repo, item.number);
      prBody = ctx.body;
      changedFiles = ctx.files;
    } catch {
      // Evidence is an enhancement; the summary still runs without it.
    }
    return await summarizeForBoss({
      key: item.id,
      ticketTitle: item.ticket?.title ?? item.title,
      ticketBody: item.ticket?.description ?? "",
      prTitle: item.title,
      prBody,
      changedFiles,
    });
  } catch {
    return null;
  }
}

/**
 * Summaries for a set of cards, computed a few at a time. The model calls are
 * the slow part of publishing, so they run bounded-parallel rather than one
 * after another, but not all at once - a burst of 24 would hammer Anthropic.
 */
async function summariesFor(
  items: QueueItem[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!config.anthropicKey) return found;

  const limit = Math.min(4, items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const item = items[next++];
        const summary = await bossUpdateFor(item);
        if (summary) found.set(item.id, summary);
      }
    }),
  );
  return found;
}

/**
 * Exactly what publishing would send, without sending it or needing a Slack
 * token. This is how the cards get checked - against real queue data, in
 * Slack's own Block Kit Builder - before the app is pointed at anyone's DMs.
 */
export async function previewReadyQueue(): Promise<{
  ready: number;
  cards: SlackCard[];
}> {
  const queue = await getQueue();
  const ready = queue.items.filter((item) => item.mergeable);
  const summaries = await summariesFor(ready);
  return {
    ready: ready.length,
    cards: [...ready].reverse().map((item) => ({
      id: item.id,
      text: `${READY_PREFIX}${item.id}`,
      blocks: readyBlocks(item, summaries.get(item.id)),
    })),
  };
}

export async function publishReadyQueue(): Promise<{
  channel: string;
  posted: number;
  retired: number;
  ready: number;
}> {
  if (!config.slackBotToken || !config.slackSigningSecret) {
    throw new Error("Slack bot token and signing secret are not configured.");
  }

  const bot = getSlackBot();
  await bot.initialize();
  const slack = bot.getAdapter("slack") as SlackAdapter;
  const channel = await targetChannel(slack);
  const queue = await getQueue();
  const ready = queue.items.filter((item) => item.mergeable);
  const readyById = new Map(ready.map((item) => [item.id, item]));

  const history = await slack.webClient.conversations.history({
    channel,
    limit: 100,
  });
  const existing = new Map<string, SlackHistoryMessage>();
  for (const message of (history.messages ?? []) as SlackHistoryMessage[]) {
    const id = readyId(message);
    if (id && message.ts) existing.set(id, message);
  }

  const STALE_DETAIL =
    "Its status changed or it left the active queue. No merge was performed.";

  let retired = 0;
  for (const [id, message] of existing) {
    if (readyById.has(id) || !message.ts) continue;
    const blocks = withStatus(message.blocks, "stale", STALE_DETAIL);
    await slack.webClient.chat.update({
      channel,
      ts: message.ts,
      text: `No longer ready: ${id}`,
      blocks:
        blocks.length > 0
          ? blocks
          : finalBlocks(prLabel(id), "stale", STALE_DETAIL),
    });
    retired += 1;
  }

  // Summaries are computed once, only for the cards about to be posted - never
  // for PRs that already have a card. A quiet cycle does no model work at all.
  const fresh = ready.filter((item) => !existing.has(item.id));
  const summaries = await summariesFor(fresh);

  let posted = 0;
  // Slack reads newest at the bottom. Post oldest first so the most-recently
  // active PR is the final card in the batch.
  for (const item of [...fresh].reverse()) {
    await slack.webClient.chat.postMessage({
      channel,
      text: `${READY_PREFIX}${item.id}`,
      blocks: readyBlocks(item, summaries.get(item.id)),
      unfurl_links: false,
      unfurl_media: false,
    });
    posted += 1;
  }

  return { channel, posted, retired, ready: ready.length };
}
