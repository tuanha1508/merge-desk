import { createHash } from "node:crypto";
import { config } from "./config";
import {
  loadStoredSummary,
  upsertStoredSummary,
} from "./merge-desk-store";

/**
 * The boss update spec, verbatim. Locked - the only variable is the input.
 */
const SYSTEM_PROMPT = `Write a 2-sentence update for my boss. Non-technical, wants the root cause and what we did.

- Max 2 sentences, under 45 words total. Count the words before you answer.
- Sentence 1: root cause as cause-and-effect (X was doing Y, so Z broke).
- Sentence 2: what we changed, and reassure the thing they'd worry about.

Grounding - this message gets forwarded to an executive as fact:
- Describe ONLY work evidenced in the material you were given.
- Never claim anything was tested, verified, rotated, backfilled, migrated, monitored, or released unless the material says so.
- Never promise there is no risk, no impact, or nothing else affected.
- Describe the change that was actually made, not the fix the reporter asked for.
- If the change does not address the reported problem, still write exactly 2 sentences: the first says what the change actually does, the second says plainly that it does not address the reported issue. Never refuse, never explain your reasoning, never add notes, recommendations, word counts, or questions.
- If nothing in the material supports a reassurance, stop sentence 2 after what changed. A shorter honest update beats a fuller confident one.

Style:
- Plain spoken English, like texting a colleague.
- Use a hyphen ( - ), never an em dash.
- No bullets, headings, bold, emoji, or openers like "Here's an update".
- No file names, function names, ticket IDs or tool names in the output. Changed paths are context for you, never something to name.
- Output only the message, nothing else.`;

/** Strip markdown images/links so the model sees prose, not asset URLs. */
export function stripMarkdownNoise(md: string): string {
  return (md ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/https?:\/\/\S+/g, "") // bare urls
    .replace(/```[\s\S]*?```/g, "") // code fences
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SummaryInput {
  key: string;
  ticketTitle: string;
  ticketBody: string;
  prTitle: string;
  /** The PR description, when it has one - real evidence for sentence 2. */
  prBody?: string;
  /** Touched paths. Context for what changed, never named in the output. */
  changedFiles?: string[];
}

/*
  Keyed on the content, not just the PR number: editing the ticket or force
  pushing a different fix has to produce a different summary, and a key of
  `repo#number` alone would serve the stale one until the process restarted.
*/
function cacheKey(input: SummaryInput, prompt: string): string {
  return createHash("sha256")
    .update(
      [
        input.key,
        prompt,
        input.ticketTitle,
        input.ticketBody,
        input.prTitle,
        input.prBody ?? "",
        (input.changedFiles ?? []).join(","),
      ].join("\u0000"),
    )
    .digest("hex");
}

const CACHE_LIMIT = 500;
const cache = new Map<string, string>();

function remember(key: string, value: string): void {
  cache.set(key, value);
  // Map iterates in insertion order, so the first key is the oldest.
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The spec asks for a hyphen and forbids the em dash, but models reach for
 * dash punctuation regardless, so it is normalised here rather than trusted
 * to the prompt. Covers em, en, and horizontal bar.
 */
function normaliseDashes(text: string): string {
  return text.replace(/\s*[—–―]\s*/g, " - ").replace(/ {2,}/g, " ");
}

const WORD_CAP = 45;

const MARKDOWN = /[*#`]|^\s*[-•\d]+[.)]\s/m;

/*
  The model sometimes answers the operator instead of writing the update -
  asking for the diff, or narrating why it cannot comply. Observed verbatim in
  testing: "I don't have material describing what the actual change does.
  Please share the details of what was changed". A boss update never asks a
  question, so a trailing question mark is caught too.
*/
const ADDRESSES_OPERATOR =
  /\b(word count|cannot write|can'?t write|I'd recommend|I need (?:to flag|material|the)|as an AI|I (?:still )?don'?t have|please share|could you share|can you share|material provided|so I can write)\b|\?\s*$/i;

/**
 * Prompt rules the model reliably breaks once it has real material to work
 * from: it runs long, and when the change does not match the ticket it tries
 * to explain itself instead of answering. Checked here so a bad draft gets one
 * corrective turn rather than reaching the person forwarding it.
 */
function specViolation(text: string): string | null {
  const words = text.trim().split(/\s+/).length;
  if (words > WORD_CAP) {
    return `That draft was ${words} words. Rewrite it as 2 sentences under ${WORD_CAP} words total, keeping only the most important cause and the change.`;
  }
  if (MARKDOWN.test(text)) {
    return "Remove all markdown, bullets and numbering. Output plain sentences only.";
  }
  if (ADDRESSES_OPERATOR.test(text)) {
    return "Output only the 2-sentence message itself. Do not ask for more material or comment on the task - write the update from what you were given.";
  }
  return null;
}

/**
 * Running long is a flaw the reader can live with. Markdown scaffolding or the
 * model talking about its own task is not forwardable at all, so a draft that
 * still does either after correction is withheld.
 */
function isUnusable(text: string): boolean {
  return MARKDOWN.test(text) || ADDRESSES_OPERATOR.test(text);
}

const RETRY_DELAYS_MS = [400, 1200];

/** 429 and 5xx are worth another go; a 4xx means the request itself is wrong. */
const isRetryableStatus = (status: number) => status === 429 || status >= 500;

type Msg = { role: "user" | "assistant"; content: string };

/** One completion, with transport-level retries. */
async function callModel(messages: Msg[]): Promise<string | null> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": config.anthropicKey!,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          model: config.anthropicModel,
          max_tokens: 300,
          system: SYSTEM_PROMPT,
          messages,
        }),
      });

      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        return null;
      }

      const json = (await res.json()) as any;
      const text: unknown = json?.content?.[0]?.text;
      return typeof text === "string" ? text : null;
    } catch {
      // Network-level failure: worth retrying, unlike a rejected request.
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function summarizeForBoss(
  input: SummaryInput,
): Promise<string | null> {
  const ck = cacheKey(input, SYSTEM_PROMPT);
  const cached = cache.get(ck);
  if (cached) return cached;

  const stored = await loadStoredSummary(ck);
  if (stored) {
    remember(ck, stored);
    return stored;
  }

  // A durable cache hit remains usable even if the model key is temporarily
  // absent; only a genuine cache miss requires Anthropic.
  if (!config.anthropicKey) return null;

  const problem = stripMarkdownNoise(input.ticketBody).slice(0, 4000);
  const prBody = stripMarkdownNoise(input.prBody ?? "").slice(0, 2000);
  // Enough paths to show the shape of the change without flooding the prompt.
  const files = (input.changedFiles ?? []).slice(0, 40);

  const userContent = [
    `Problem reported: ${input.ticketTitle}`,
    problem ? `Details: ${problem}` : null,
    `What we shipped: ${input.prTitle}`,
    prBody ? `Change description: ${prBody}` : null,
    files.length ? `Files touched (context only, never name these): ${files.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: Msg[] = [{ role: "user", content: userContent }];
  let draft: string | null = null;

  // One draft, then at most one corrective turn quoting the specific breach.
  for (let round = 0; round < 2; round++) {
    const raw = await callModel(messages);
    if (!raw) break;

    const clean = normaliseDashes(raw.trim());
    const breach = specViolation(clean);
    if (!breach) {
      remember(ck, clean);
      await upsertStoredSummary(ck, input.key, clean);
      return clean;
    }

    draft = clean;
    messages.push({ role: "assistant", content: raw.trim() });
    messages.push({ role: "user", content: breach });
  }

  // Still off-spec. Long is forwardable with a glance; commentary is not.
  if (draft && !isUnusable(draft)) {
    remember(ck, draft);
    await upsertStoredSummary(ck, input.key, draft);
    return draft;
  }
  return null;
}
