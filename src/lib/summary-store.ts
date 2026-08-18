"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { QueueItem } from "./types";

/*
  The boss update now appears on every row, not just the opened one, so the
  page would otherwise fire one request per pull request the moment it renders.
  Requests are funnelled through this module instead: results are shared with
  the detail view, in-flight work is deduped, and only a few run at once so the
  list fills top-down rather than stalling behind a burst of model calls.
*/

const MAX_PARALLEL = 3;

const cache = new Map<string, string>();
const failed = new Map<string, string>();
const inFlight = new Set<string>();
const pending: Array<{ key: string; item: QueueItem }> = [];
const listeners = new Set<() => void>();

let active = 0;
let version = 0;

/*
  Keyed on the material the summary is written from, so a poll that only hands
  down a new object is free while an edited ticket or a force push regenerates.
*/
function materialKey(item: QueueItem): string {
  return [
    item.id,
    item.updatedAt,
    item.title,
    item.ticket?.title ?? "",
    item.ticket?.description ?? "",
  ].join("\u0000");
}

/*
  The material carries the whole ticket description, so it is hashed down to a
  short token before it becomes a key. That keeps the persisted map small and,
  just as importantly, keeps customer ticket text out of localStorage - only
  the forwardable one-liner and an opaque hash are ever written to disk.
*/
function keyFor(item: QueueItem): string {
  const material = materialKey(item);
  let h = 5381;
  for (let i = 0; i < material.length; i++) {
    h = ((h << 5) + h + material.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/*
  A hard refresh drops every in-memory map, so without this each reload would
  re-request all summaries and show the shimmer again. The successful ones are
  mirrored to localStorage and read back synchronously on load, so a reload
  paints the same text with no network at all. Miss or edit still refetches,
  because the hash changes with the material.
*/
const STORE_KEY = "mq:summaries:v1";
const PERSIST_LIMIT = 300;

function hydrate(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw) as [string, string][];
    for (const [k, v] of entries) {
      if (typeof k === "string" && typeof v === "string") cache.set(k, v);
    }
  } catch {
    // Corrupt or unavailable storage is not worth failing the page over.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  if (typeof window === "undefined" || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // Map keeps insertion order; the newest PERSIST_LIMIT entries are kept.
      const entries = [...cache.entries()].slice(-PERSIST_LIMIT);
      window.localStorage.setItem(STORE_KEY, JSON.stringify(entries));
    } catch {
      // Quota or private-mode failures are non-fatal; the session cache stays.
    }
  }, 300);
}

hydrate();

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getVersion = () => version;
const getServerVersion = () => 0;

async function run(key: string, item: QueueItem): Promise<void> {
  try {
    const res = await fetch("/api/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: item.id,
        repo: item.repo,
        number: item.number,
        ticketTitle: item.ticket?.title ?? item.title,
        ticketBody: item.ticket?.description ?? "",
        prTitle: item.title,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.summary) {
      // Only a real summary is remembered - an error has to stay retryable.
      cache.set(key, data.summary);
      persist();
    } else {
      failed.set(key, data.error ?? "Could not write an update for this one.");
    }
  } catch {
    failed.set(key, "Could not reach the summary service.");
  }
}

function pump(): void {
  while (active < MAX_PARALLEL && pending.length > 0) {
    const job = pending.shift()!;
    active++;
    inFlight.add(job.key);
    void run(job.key, job.item).finally(() => {
      active--;
      inFlight.delete(job.key);
      emit();
      pump();
    });
  }
}

/** Queue a summary if it is not already known, failed, or on its way. */
export function request(item: QueueItem): void {
  const key = keyFor(item);
  if (cache.has(key) || failed.has(key) || inFlight.has(key)) return;
  if (pending.some((job) => job.key === key)) return;
  pending.push({ key, item });
  pump();
}

export interface SummaryState {
  text: string | null;
  error: string | null;
  loading: boolean;
}

/**
 * Subscribes to the shared store and asks for this item's update. Safe to call
 * from many rows at once - the work is deduped and rate limited centrally.
 */
export function useSummary(item: QueueItem): SummaryState {
  const key = keyFor(item);

  useSyncExternalStore(subscribe, getVersion, getServerVersion);

  useEffect(() => {
    request(item);
    // The item object changes identity on every poll; the material key is what
    // actually decides whether a new summary is needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const text = cache.get(key) ?? null;
  const error = failed.get(key) ?? null;
  return { text, error, loading: !text && !error };
}
