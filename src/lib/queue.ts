import { config, isMockMode } from "./config";
import { evaluateGate, listOpenPRs, type RawPR } from "./github";
import { extractTicketRef, getTickets } from "./linear";
import { resolveCustomer } from "./email-resolver";
import { stripMarkdownNoise } from "./summarize";
import { mockQueue } from "./mock";
import type { QueueItem, ReviewGate } from "./types";

const MEDIA_FILENAME =
  /^[\w\s.,'-]+\.(png|jpe?g|gif|webp|svg|pdf|mov|mp4|heic|zip)$/i;

/** Titles like "Bug" or "Feedback" name a category, not a problem. */
const GENERIC_TITLE =
  /^(bug|bug report|issue|issues|feedback|support|question|help|task|request|problem)\b[\s.:-]*$/i;

/** Strip the markdown scaffolding that survives inside a single line. */
function cleanLine(raw: string): string {
  return raw
    .replace(/^\s*>+\s*/, "") // blockquote
    .replace(/^\s*[-*+]\s+/, "") // bullet
    .replace(/^\s*\d+[.)]\s+/, "") // numbered
    .replace(/^\s*\[[ xX]\]\s*/, "") // checkbox
    .replace(/^\s*(?:\[[^\]]{1,24}\]\s*)+/, "") // "[PTF-12]", "[Billing]" tags
    .replace(/\*\*|__/g, "") // bold
    .replace(/(^|\s)[*_](\S[^*_]*)[*_](\s|$)/g, "$1$2$3") // italic
    .replace(/`/g, "") // inline code
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads as a reported problem rather than a section label or a metadata pair.
 * Headings ("Full email thread"), label lines ("Steps to reproduce:") and
 * key/value rows ("Trace finding: PTF-12") all name structure, not symptoms.
 */
function looksLikeProblem(line: string): boolean {
  if (line.length < 12 || !/[a-z]/i.test(line)) return false;
  if (MEDIA_FILENAME.test(line)) return false;
  if (line.endsWith(":")) return false;
  if (/^[\w\s]{1,24}:\s*\S{1,24}$/.test(line)) return false;
  return line.split(/\s+/).length >= 4;
}

/**
 * One-line problem for the row. The ticket title is usually the best summary
 * a human already wrote, so it wins unless it is generic or an attachment
 * name; only then do we go hunting in the body.
 */
function problemLine(title: string, description: string, max = 140): string {
  const clip = (s: string) =>
    s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;

  const cleanTitle = cleanLine(title);
  if (
    cleanTitle &&
    !GENERIC_TITLE.test(cleanTitle) &&
    !MEDIA_FILENAME.test(cleanTitle)
  ) {
    return clip(cleanTitle);
  }

  const fromBody = stripMarkdownNoise(description)
    .split(/\r?\n/)
    .filter((l) => !/^\s*#{1,6}\s/.test(l)) // section headings
    .map(cleanLine)
    .find(looksLikeProblem);

  return clip(fromBody ?? cleanTitle ?? title);
}

function decideMerge(item: Omit<QueueItem, "mergeable" | "blockedReason">): {
  mergeable: boolean;
  blockedReason: string | null;
} {
  const reasons: string[] = [];
  if (config.requireGreenCI && !item.gate.ciGreen) {
    reasons.push(
      item.gate.ciState === "pending"
        ? "Checks are still running"
        : "Required checks are failing",
    );
  }
  if (item.gate.unresolvedBotReviews > 0) {
    const who = item.gate.blockingBots.join(", ");
    reasons.push(
      `${item.gate.unresolvedBotReviews} unresolved bot review${
        item.gate.unresolvedBotReviews === 1 ? "" : "s"
      }${who ? ` (${who})` : ""}`,
    );
  }
  return {
    mergeable: reasons.length === 0,
    blockedReason: reasons.length ? reasons.join(" · ") : null,
  };
}

type TicketMap = Awaited<ReturnType<typeof getTickets>>;

async function buildItem(
  pr: RawPR,
  tickets: TicketMap,
  allowVision: boolean,
): Promise<QueueItem> {
  // Branch name and title almost always carry the Linear ref; PR body is no
  // longer pulled on the list query (summaries fetch it lazily).
  const ref = extractTicketRef(pr.headRef, pr.title);
  const ticket = ref ? (tickets.get(ref.toUpperCase()) ?? null) : null;
  const customer = await resolveCustomer(ticket, { allowVision });

  const base = {
    id: `${pr.repo}#${pr.number}`,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    url: pr.url,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    ticket,
    customer,
    problem: ticket
      ? problemLine(ticket.title, ticket.description)
      : pr.title,
    gate: pr.gate,
  };
  return { ...base, ...decideMerge(base) };
}

function withGate(item: QueueItem, pr: RawPR): QueueItem {
  const next = {
    ...item,
    title: pr.title,
    author: pr.author,
    url: pr.url,
    updatedAt: pr.updatedAt,
    gate: pr.gate,
  };
  return { ...next, ...decideMerge(next) };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        output[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

/*
  A page load, the background fill, and every poll all ask for the same data
  within seconds of each other. Recomputing it each time costs a full GitHub
  and Linear round trip, so a completed queue is reused briefly. The window is
  short enough that a merge elsewhere still shows up promptly, and the merge
  path re-checks its gates against GitHub regardless of what this holds.
*/
const CACHE_TTL_MS = 45_000;

type CacheEntry = { at: number; items: QueueItem[]; missingRepos: string[] };
const queueCache = new Map<number, CacheEntry>();

function cachedEntry(maxItems: number): CacheEntry | null {
  const now = Date.now();
  for (const [size, entry] of queueCache) {
    if (now - entry.at > CACHE_TTL_MS) {
      queueCache.delete(size);
      continue;
    }
    // A larger completed queue answers a smaller request: the rows are the
    // same, already sorted by most recent activity. A degraded result is not
    // reused, so a missing repo is retried on the very next request.
    if (size >= maxItems && entry.missingRepos.length === 0) return entry;
  }
  return null;
}

/** Drop cached rows after a successful merge so the next poll rebuilds cleanly. */
export function invalidateQueueCache(): void {
  queueCache.clear();
}

export interface QueueResult {
  mock: boolean;
  items: QueueItem[];
  /** Repos GitHub could not serve. Their rows are absent from `items`. */
  missingRepos: string[];
  /** Whether this payload reused prior enrichment and only refreshed gates. */
  mode?: "full" | "gates";
}

export interface GetQueueOptions {
  maxItems?: number;
  /**
   * When true, run screenshot vision for unresolved customers. Default false
   * so first paint and polls stay fast; the UI opts in via "Search again".
   */
  allowVision?: boolean;
}

async function listAllOpenPRs(maxItems: number): Promise<{
  capped: RawPR[];
  missingRepos: string[];
}> {
  // Asking each repo for maxItems is sufficient to find the global maxItems:
  // no PR ranked below that within its own repo can enter the global top set.
  // This matters for first paint, which asks for only the newest handful and
  // therefore avoids gate and customer lookups for the remaining queue.
  /*
    One repo failing must not blank the board. GitHub's transient errors are
    already retried a level down, so anything still failing here is treated as
    that repo being temporarily unavailable: the rest of the queue renders and
    the next poll picks the missing rows back up.
  */
  const settled = await Promise.allSettled(
    config.repos.map((repo) => listOpenPRs(repo, maxItems)),
  );
  const missingRepos: string[] = [];
  const listed = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    missingRepos.push(config.repos[index]);
    console.error(
      `queue: skipping ${config.repos[index]} - ${
        result.reason instanceof Error ? result.reason.message : result.reason
      }`,
    );
    return [];
  });
  if (listed.length === 0 && settled.length > 0) {
    const first = settled[0];
    throw first.status === "rejected"
      ? first.reason
      : new Error("queue unavailable");
  }
  const capped = listed
    .flat()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, maxItems);
  return { capped, missingRepos };
}

async function enrichPRs(
  capped: RawPR[],
  allowVision: boolean,
): Promise<QueueItem[]> {
  const refs = capped
    .map((pr) => extractTicketRef(pr.headRef, pr.title))
    .filter((ref): ref is string => Boolean(ref));
  const tickets = await getTickets(refs);
  // GitHub gates are already batched into the repository queries above.
  // Bound the remaining customer work so one refresh does not burst those
  // services with 50 simultaneous lookups. Linear was batched separately.
  return mapWithConcurrency(capped, 8, (pr) =>
    buildItem(pr, tickets, allowVision),
  );
}

export async function getQueue(
  options?: GetQueueOptions,
): Promise<QueueResult> {
  const maxItems = Math.min(
    Math.max(options?.maxItems ?? config.maxPrs, 1),
    config.maxPrs,
  );
  const allowVision = options?.allowVision === true;

  if (isMockMode) {
    return {
      mock: true,
      items: mockQueue.slice(0, maxItems),
      missingRepos: [],
      mode: "full",
    };
  }

  // Vision-backed lookups must not reuse a fast-path cache entry that skipped
  // screenshots - otherwise "Search again" would appear to do nothing.
  if (!allowVision) {
    const hit = cachedEntry(maxItems);
    if (hit) {
      return {
        mock: false,
        items: hit.items.slice(0, maxItems),
        missingRepos: [],
        mode: "full",
      };
    }
  }

  const { capped, missingRepos } = await listAllOpenPRs(maxItems);
  const items = await enrichPRs(capped, allowVision);
  if (!allowVision) {
    queueCache.set(maxItems, { at: Date.now(), items, missingRepos });
  }
  return { mock: false, items, missingRepos, mode: "full" };
}

/**
 * Cheap poll path: re-fetch GitHub gates for the open PR set, reuse Linear /
 * customer enrichment for rows that are still open, and only buildItem for
 * brand-new PRs. Falls back to a full getQueue when there is nothing cached.
 */
export async function refreshQueueGates(
  options?: GetQueueOptions,
): Promise<QueueResult> {
  const maxItems = Math.min(
    Math.max(options?.maxItems ?? config.maxPrs, 1),
    config.maxPrs,
  );

  if (isMockMode) {
    return {
      mock: true,
      items: mockQueue.slice(0, maxItems),
      missingRepos: [],
      mode: "gates",
    };
  }

  const prior =
    cachedEntry(maxItems) ??
    [...queueCache.entries()]
      .filter(([, entry]) => Date.now() - entry.at <= CACHE_TTL_MS * 4)
      .sort((a, b) => b[0] - a[0])[0]?.[1];

  if (!prior || prior.items.length === 0) {
    return getQueue({ maxItems, allowVision: false });
  }

  const { capped, missingRepos } = await listAllOpenPRs(maxItems);
  const priorById = new Map(prior.items.map((item) => [item.id, item]));
  const next: QueueItem[] = [];
  const newcomers: RawPR[] = [];

  for (const pr of capped) {
    const id = `${pr.repo}#${pr.number}`;
    const existing = priorById.get(id);
    if (existing) {
      // Title/ticket material rarely changes between polls; CI and bot threads
      // do. Reuse enrichment and stamp the fresh gate.
      next.push(withGate(existing, pr));
    } else {
      newcomers.push(pr);
    }
  }

  if (newcomers.length > 0) {
    const built = await enrichPRs(newcomers, false);
    next.push(...built);
  }

  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const items = next.slice(0, maxItems);
  queueCache.set(maxItems, { at: Date.now(), items, missingRepos });
  return { mock: false, items, missingRepos, mode: "gates" };
}

/* ------------------------------------------------------------------ */
/* Webhook fast-path: patch cached rows straight from GitHub events.  */
/* ------------------------------------------------------------------ */

/**
 * Live (non-expired) cache entries, pruning any that have aged out. Every
 * webhook patch touches all of them so a page asking for 5 rows and a poll
 * asking for 50 stay consistent.
 */
function liveEntries(): Array<[number, CacheEntry]> {
  const now = Date.now();
  const out: Array<[number, CacheEntry]> = [];
  for (const [size, entry] of queueCache) {
    if (now - entry.at > CACHE_TTL_MS) {
      queueCache.delete(size);
      continue;
    }
    out.push([size, entry]);
  }
  return out;
}

function queueHasItem(repo: string, number: number): boolean {
  const id = `${repo}#${number}`;
  return liveEntries().some(([, entry]) =>
    entry.items.some((item) => item.id === id),
  );
}

/** Drop one PR from every cached page. Returns whether anything changed. */
function removeQueueItem(repo: string, number: number): boolean {
  const id = `${repo}#${number}`;
  let changed = false;
  for (const [, entry] of liveEntries()) {
    const before = entry.items.length;
    entry.items = entry.items.filter((item) => item.id !== id);
    if (entry.items.length !== before) changed = true;
  }
  return changed;
}

/** Stamp a freshly-evaluated gate onto one PR wherever it is cached. */
function patchQueueGate(
  repo: string,
  number: number,
  gate: ReviewGate,
): boolean {
  const id = `${repo}#${number}`;
  let changed = false;
  for (const [, entry] of liveEntries()) {
    entry.items = entry.items.map((item) => {
      if (item.id !== id) return item;
      changed = true;
      const next = { ...item, gate };
      return { ...next, ...decideMerge(next) };
    });
  }
  return changed;
}

/** Insert or replace one enriched row in every cached page, then re-order. */
function upsertQueueItem(item: QueueItem): void {
  for (const [size, entry] of liveEntries()) {
    const without = entry.items.filter((existing) => existing.id !== item.id);
    without.push(item);
    without.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    entry.items = without.slice(0, size);
  }
}

export interface WebhookEvent {
  event: "pull_request" | "check_run" | "pull_request_review_thread";
  action: string | null;
  repo: string;
  pr: {
    number: number;
    title?: string;
    author?: string;
    url?: string;
    createdAt?: string;
    updatedAt?: string;
    headRef?: string;
    state?: string;
    draft?: boolean;
    merged?: boolean;
  } | null;
}

export interface WebhookOutcome {
  patched: boolean;
  action: "removed" | "upserted" | "gate-refreshed" | "skipped";
  detail?: string;
}

async function upsertFromWebhookPR(
  repo: string,
  pr: NonNullable<WebhookEvent["pr"]>,
): Promise<WebhookOutcome> {
  if (
    !pr.title ||
    !pr.author ||
    !pr.url ||
    !pr.createdAt ||
    !pr.updatedAt ||
    pr.headRef === undefined
  ) {
    invalidateQueueCache();
    return {
      patched: false,
      action: "skipped",
      detail: "incomplete pull_request payload",
    };
  }

  // A PR whose last activity is older than the list cutoff would never appear
  // in a normal fetch, so it must not be injected here either.
  const cutoff = Date.now() - config.maxPrAgeDays * 24 * 60 * 60 * 1000;
  if (new Date(pr.updatedAt).getTime() < cutoff) {
    const removed = removeQueueItem(repo, pr.number);
    return { patched: removed, action: "removed", detail: "outside active window" };
  }

  // Nothing is holding this repo's rows right now; the next fetch will include
  // the PR anyway, so skip the enrichment work.
  if (liveEntries().length === 0) {
    return { patched: false, action: "skipped", detail: "no live cache" };
  }

  // The payload carries title/author/timestamps but not the CI rollup or
  // review threads, so the gate is evaluated fresh.
  const gate = await evaluateGate(repo, pr.number).catch(() => null);
  if (!gate) {
    invalidateQueueCache();
    return { patched: false, action: "skipped", detail: "gate lookup failed" };
  }

  const raw: RawPR = {
    repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    url: pr.url,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    headRef: pr.headRef,
    gate,
  };
  const [item] = await enrichPRs([raw], false);
  upsertQueueItem(item);
  return { patched: true, action: "upserted" };
}

/**
 * Apply a verified GitHub webhook to this process's queue cache so the change
 * shows up on the very next read instead of after a poll.
 *
 * The cache is per-instance and best-effort: a delivery may land on a warm
 * instance that is not the one serving a given browser. That is acceptable -
 * anything not patched here is still corrected by the 45s cache window and the
 * client poll. When a patch cannot be made confidently, the cache is cleared so
 * the next read rebuilds from GitHub rather than serving something stale.
 */
export async function applyWebhookEvent(
  evt: WebhookEvent,
): Promise<WebhookOutcome> {
  if (isMockMode) {
    return { patched: false, action: "skipped", detail: "mock mode" };
  }

  const number = evt.pr?.number;
  if (!number) {
    invalidateQueueCache();
    return { patched: false, action: "skipped", detail: "no pull request number" };
  }

  if (evt.event === "pull_request") {
    // Merged, closed or turned-into-draft PRs leave the board immediately -
    // the cheapest, highest-value patch, and it needs no API call.
    if (
      evt.action === "closed" ||
      evt.pr?.state === "closed" ||
      evt.action === "converted_to_draft" ||
      evt.pr?.draft === true
    ) {
      const removed = removeQueueItem(evt.repo, number);
      return { patched: removed, action: "removed" };
    }
    // opened / reopened / ready_for_review / edited / synchronize: (re)build the
    // row so its ticket, customer and gate match a normal fetch.
    return upsertFromWebhookPR(evt.repo, evt.pr!);
  }

  // check_run + review-thread events only move the gate. Ignoring one for a PR
  // we are not holding costs nothing and avoids a pointless API call.
  if (!queueHasItem(evt.repo, number)) {
    return { patched: false, action: "skipped", detail: "pr not cached" };
  }
  const gate = await evaluateGate(evt.repo, number).catch(() => null);
  if (!gate) {
    invalidateQueueCache();
    return { patched: false, action: "skipped", detail: "gate lookup failed" };
  }
  const changed = patchQueueGate(evt.repo, number, gate);
  return { patched: changed, action: "gate-refreshed" };
}
