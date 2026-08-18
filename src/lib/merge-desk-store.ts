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
      reportOnce(operation, `${response.status} ${detail || response.statusText}`);
      return null;
    }
    return response;
  } catch (error) {
    reportOnce(
      operation,
      error instanceof Error ? error.message : "network error",
    );
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
  const response = await request(
    "upsert queue",
    "rpc/merge_desk_upsert_queue",
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
}
