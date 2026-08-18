import { config, isMockMode } from "./config";
import { listOpenPRs, type RawPR } from "./github";
import { extractTicketRef, getTicket } from "./linear";
import { resolveCustomer } from "./email-resolver";
import { stripMarkdownNoise } from "./summarize";
import { mockQueue } from "./mock";
import type { QueueItem } from "./types";

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
        item.gate.unresolvedBotReviews > 1 ? "s" : ""
      }${who ? ` (${who})` : ""}`,
    );
  }
  return {
    mergeable: reasons.length === 0,
    blockedReason: reasons.length ? reasons.join(" · ") : null,
  };
}

async function buildItem(pr: RawPR): Promise<QueueItem> {
  const ref = extractTicketRef(pr.headRef, pr.title, pr.body);

  const ticket = ref ? await getTicket(ref) : null;
  const customer = await resolveCustomer(ticket);

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

export interface QueueResult {
  mock: boolean;
  items: QueueItem[];
  /** Repos GitHub could not serve. Their rows are absent from `items`. */
  missingRepos: string[];
}

export async function getQueue(options?: {
  maxItems?: number;
}): Promise<QueueResult> {
  const maxItems = Math.min(
    Math.max(options?.maxItems ?? config.maxPrs, 1),
    config.maxPrs,
  );
  if (isMockMode) {
    return {
      mock: true,
      items: mockQueue.slice(0, maxItems),
      missingRepos: [],
    };
  }

  const hit = cachedEntry(maxItems);
  if (hit) {
    return {
      mock: false,
      items: hit.items.slice(0, maxItems),
      missingRepos: [],
    };
  }

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
      `queue: skipping ${config.repos[index]} - ${result.reason instanceof Error ? result.reason.message : result.reason}`,
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

  // GitHub gates are already batched into the two repository queries above.
  // Bound the remaining Linear/customer work so one refresh does not burst
  // those services with 50 simultaneous lookups.
  const items = await mapWithConcurrency(capped, 8, buildItem);
  queueCache.set(maxItems, { at: Date.now(), items, missingRepos });
  return { mock: false, items, missingRepos };
}
