import { config } from "./config";

/*
  Live updates, server side. When a webhook or a merge changes the queue we
  send one small broadcast on a Supabase Realtime channel. Open boards listen
  on the same channel (with the public anon key) and refresh immediately,
  instead of waiting up to a full poll interval.

  The ping deliberately carries no pull-request data - just a "something moved"
  signal and what kind. Clients then re-read the queue through the normal
  authenticated endpoint, so customer emails never travel over the public
  channel. That keeps this safe to run with the anon key in the browser.
*/

export type QueueChange = "upserted" | "removed" | "gate-refreshed" | "merged";

const REALTIME_ENABLED = Boolean(config.supabaseUrl && config.supabaseKey);
let warned = false;

/**
 * Best-effort broadcast of a queue change. Never throws and never blocks the
 * caller on the network for long: a dropped ping only means a client waits for
 * its next poll, which is the pre-realtime behaviour.
 */
export async function broadcastQueueChanged(change: QueueChange): Promise<void> {
  if (!REALTIME_ENABLED) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(
      `${config.supabaseUrl}/realtime/v1/api/broadcast`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          apikey: config.supabaseKey!,
          Authorization: `Bearer ${config.supabaseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            {
              topic: config.realtimeChannel,
              event: "queue-changed",
              payload: { change, at: new Date().toISOString() },
            },
          ],
        }),
      },
    );
    if (!response.ok && !warned) {
      warned = true;
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      console.error(
        `merge-desk realtime: broadcast failed - ${response.status} ${detail || response.statusText}`,
      );
    }
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error(
        `merge-desk realtime: broadcast failed - ${
          error instanceof Error ? error.message : "network error"
        }`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
