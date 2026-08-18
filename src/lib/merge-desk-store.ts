import { config } from "./config";
import type { QueueItem } from "./types";

const RETENTION_MS = config.maxPrAgeDays * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastCleanupAt = 0;
const reported = new Set<string>();

function enabled(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseKey);
}

function headers(prefer?: string): Record<string, string> {
  return {
    apikey: config.supabaseKey!,
    Authorization: `Bearer ${config.supabaseKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

function endpoint(path: string, params?: URLSearchParams): string {
  const query = params?.toString();
  return `${config.supabaseUrl}/rest/v1/${path}${query ? `?${query}` : ""}`;
}

function reportOnce(operation: string, detail: string): void {
  const key = `${operation}:${detail}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`merge-desk store: ${operation} failed - ${detail}`);
}

async function request(
  operation: string,
  path: string,
  init?: RequestInit,
  params?: URLSearchParams,
  quiet = false,
): Promise<Response | null> {
  if (!enabled()) return null;
  try {
    const response = await fetch(endpoint(path, params), {
      ...init,
      headers: {
        ...headers(),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      if (!quiet) {
        reportOnce(operation, `${response.status} ${detail || response.statusText}`);
      }
      return null;
    }
    return response;
  } catch (error) {
    if (!quiet) {
      reportOnce(
        operation,
        error instanceof Error ? error.message : "network error",
      );
    }
    return null;
  }
}

function isQueueItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueueItem>;
  return (
    typeof item.id === "string" &&
    typeof item.repo === "string" &&
    typeof item.number === "number" &&
    typeof item.title === "string" &&
    typeof item.updatedAt === "string" &&
    Boolean(item.gate) &&
    Boolean(item.customer)
  );
}

export interface StoredQueue {
  items: QueueItem[];
  itemCount: number;
  syncedAt: string;
}

/**
 * Read a complete queue snapshot. The state marker is required: rows written
 * by a webhook or a five-row first paint are useful, but do not prove that the
 * table contains the whole capped queue.
 */
export async function loadStoredQueue(
  maxItems: number,
): Promise<StoredQueue | null> {
  if (!enabled()) return null;

  const now = new Date().toISOString();
  const rowsParams = new URLSearchParams({
    select: "payload",
    expires_at: `gt.${now}`,
    order: "updated_at.desc",
    limit: String(maxItems),
  });
  const stateParams = new URLSearchParams({
    select: "item_count,synced_at",
    key: "eq.queue",
    limit: "1",
  });

  const [rowsResponse, stateResponse] = await Promise.all([
    request("load queue", config.mergeDeskQueueTable, undefined, rowsParams),
    request("load queue state", config.mergeDeskStateTable, undefined, stateParams),
  ]);
  if (!rowsResponse || !stateResponse) return null;

  const rows = (await rowsResponse.json().catch(() => [])) as Array<{
    payload?: unknown;
  }>;
  const states = (await stateResponse.json().catch(() => [])) as Array<{
    item_count?: unknown;
    synced_at?: unknown;
  }>;
  const state = states[0];
  if (
    !state ||
    typeof state.item_count !== "number" ||
    typeof state.synced_at !== "string"
  ) {
    return null;
  }

  const items = rows.map((row) => row.payload).filter(isQueueItem);
  // Over-cap snapshots mean webhook upserts grew past the product limit before
  // trimming existed. Refuse them so the next full reconcile rebuilds cleanly.
  if (state.item_count > config.maxPrs) return null;
  const expected = Math.min(maxItems, state.item_count);
  if (items.length !== expected) return null;
  return { items, itemCount: state.item_count, syncedAt: state.synced_at };
}

export async function loadStoredQueueItem(
  id: string,
): Promise<QueueItem | null> {
  const params = new URLSearchParams({
    select: "payload",
    id: `eq.${id}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });
  const response = await request(
    "load queue item",
    config.mergeDeskQueueTable,
    undefined,
    params,
  );
  if (!response) return null;
  const rows = (await response.json().catch(() => [])) as Array<{
    payload?: unknown;
  }>;
  return isQueueItem(rows[0]?.payload) ? rows[0].payload : null;
}

export async function upsertStoredQueueItems(
  items: QueueItem[],
): Promise<boolean> {
  if (!enabled() || items.length === 0) return false;

  // Prefer the capped RPC. Fall back to the older two-arg form plus a REST
  // trim so deploys stay safe before the hardening migration is applied.
  const capped = await request(
    "upsert queue",
    "rpc/merge_desk_upsert_queue",
    {
      method: "POST",
      body: JSON.stringify({
        items,
        retention_days: config.maxPrAgeDays,
        max_items: config.maxPrs,
      }),
    },
    undefined,
    true,
  );
  if (capped) return true;

  const legacy = await request(
    "upsert queue legacy",
    "rpc/merge_desk_upsert_queue",
    {
      method: "POST",
      body: JSON.stringify({
        items,
        retention_days: config.maxPrAgeDays,
      }),
    },
  );
  if (!legacy) return false;
  await trimStoredQueueToCap();
  return true;
}

/** Drop oldest active rows when the durable set drifts past the product cap. */
async function trimStoredQueueToCap(): Promise<void> {
  const now = new Date().toISOString();
  const listed = await request(
    "list queue for trim",
    config.mergeDeskQueueTable,
    undefined,
    new URLSearchParams({
      select: "id",
      expires_at: `gt.${now}`,
      order: "updated_at.desc",
    }),
  );
  if (!listed) return;
  const rows = (await listed.json().catch(() => [])) as Array<{ id?: unknown }>;
  const ids = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length <= config.maxPrs) {
    await refreshStoredQueueCount(ids.length);
    return;
  }
  const drop = ids.slice(config.maxPrs);
  const inList = drop.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
  await request(
    "trim queue",
    config.mergeDeskQueueTable,
    {
      method: "DELETE",
      headers: headers("return=minimal"),
    },
    new URLSearchParams({ id: `in.(${inList})` }),
  );
  await refreshStoredQueueCount(config.maxPrs);
}

async function refreshStoredQueueCount(itemCount: number): Promise<void> {
  await request(
    "refresh queue count",
    config.mergeDeskStateTable,
    {
      method: "PATCH",
      headers: headers("return=minimal"),
      body: JSON.stringify({ item_count: itemCount }),
    },
    new URLSearchParams({ key: "eq.queue" }),
  );
}

/**
 * Stamp the snapshot as synced now.
 *
 * A webhook patch keeps an already-complete queue complete (an upsert adds or
 * replaces one row, a delete drops one), so it is fair to move the freshness
 * marker forward. Doing so lets a cold Vercel instance serve the patched rows
 * straight from Postgres on the next read instead of falling through to a full
 * GitHub reconcile. `loadStoredQueue` still guards on item_count vs. row count,
 * so a genuinely incomplete set is rejected regardless of this timestamp.
 */
export async function markStoredQueueSynced(): Promise<void> {
  await request(
    "mark queue synced",
    config.mergeDeskStateTable,
    {
      method: "PATCH",
      headers: headers("return=minimal"),
      body: JSON.stringify({ synced_at: new Date().toISOString() }),
    },
    new URLSearchParams({ key: "eq.queue" }),
  );
}

/** Atomically replace the complete globally capped queue and mark it synced. */
export async function replaceStoredQueue(items: QueueItem[]): Promise<boolean> {
  if (!enabled()) return false;
  const response = await request(
    "replace queue",
    "rpc/merge_desk_replace_queue",
    {
      method: "POST",
      body: JSON.stringify({
        items,
        retention_days: config.maxPrAgeDays,
      }),
    },
  );
  return Boolean(response);
}

export async function deleteStoredQueueItem(id: string): Promise<boolean> {
  const response = await request(
    "delete queue item",
    "rpc/merge_desk_delete_queue",
    {
      method: "POST",
      body: JSON.stringify({ item_id: id }),
    },
  );
  return Boolean(response);
}

export async function loadStoredSummary(
  contentHash: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    select: "summary",
    content_hash: `eq.${contentHash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });
  const response = await request(
    "load summary",
    config.mergeDeskSummaryTable,
    undefined,
    params,
  );
  if (!response) return null;
  const rows = (await response.json().catch(() => [])) as Array<{
    summary?: unknown;
  }>;
  return typeof rows[0]?.summary === "string" ? rows[0].summary : null;
}

export async function upsertStoredSummary(
  contentHash: string,
  prKey: string,
  summary: string,
): Promise<boolean> {
  if (!enabled()) return false;
  const params = new URLSearchParams({ on_conflict: "content_hash" });
  const response = await request(
    "upsert summary",
    config.mergeDeskSummaryTable,
    {
      method: "POST",
      headers: headers("resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify({
        content_hash: contentHash,
        pr_key: prKey,
        summary,
        expires_at: new Date(Date.now() + RETENTION_MS).toISOString(),
      }),
    },
    params,
  );
  if (response) void cleanupExpiredRows();
  return Boolean(response);
}

/** Bound physical storage as well as reads; at most once daily per instance. */
export async function cleanupExpiredRows(): Promise<void> {
  if (!enabled() || Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = Date.now();

  const viaRpc = await request(
    "clean expired",
    "rpc/merge_desk_cleanup_expired",
    {
      method: "POST",
      body: "{}",
    },
    undefined,
    true,
  );
  if (viaRpc) return;

  // Pre-hardening fallback: delete expired rows, then recompute item_count so
  // the completeness marker cannot drift above the live row set.
  const expired = `lte.${new Date().toISOString()}`;
  await Promise.all([
    request(
      "clean queue",
      config.mergeDeskQueueTable,
      { method: "DELETE", headers: headers("return=minimal") },
      new URLSearchParams({ expires_at: expired }),
    ),
    request(
      "clean summaries",
      config.mergeDeskSummaryTable,
      { method: "DELETE", headers: headers("return=minimal") },
      new URLSearchParams({ expires_at: expired }),
    ),
  ]);

  const listed = await request(
    "count queue after clean",
    config.mergeDeskQueueTable,
    undefined,
    new URLSearchParams({
      select: "id",
      expires_at: `gt.${new Date().toISOString()}`,
    }),
  );
  if (!listed) return;
  const rows = (await listed.json().catch(() => [])) as unknown[];
  await refreshStoredQueueCount(rows.length);
}
