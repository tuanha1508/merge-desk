"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

/*
  Live updates, browser side. Subscribes to the same Supabase Realtime channel
  the server broadcasts on and calls back when the queue changes, so the board
  refreshes within a second of a merge or a webhook instead of waiting for the
  next poll.

  It only ever receives a tiny "something moved" ping - the actual rows are
  re-read through the authenticated queue endpoint - so the public anon key
  here never exposes customer data.

  If the public env vars are absent (e.g. self-hosted without Realtime), the
  hook is inert and the existing poll remains the sole freshness path.
*/

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const CHANNEL =
  process.env.NEXT_PUBLIC_MERGE_DESK_REALTIME_CHANNEL ?? "merge-desk-queue";

// A single PR moving through CI fires several webhooks in quick succession.
// Coalesce that burst into one refresh so the board does not re-fetch per event.
const DEBOUNCE_MS = 800;

export function useQueueChannel(onChange: () => void): void {
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (!URL || !ANON) return;

    const client = createClient(URL, ANON, {
      auth: { persistSession: false },
      // No user session and no presence - keep the socket lean.
      realtime: { params: { eventsPerSecond: 5 } },
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        handler.current();
      }, DEBOUNCE_MS);
    };

    const channel = client
      .channel(CHANNEL)
      .on("broadcast", { event: "queue-changed" }, schedule)
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void client.removeChannel(channel);
    };
  }, []);
}
