import type { QueueItem } from "./types";

/*
  GitHub logins stay the filter key; these are what a human reads in the
  author tabs and Slack cards. Unlisted handles fall through unchanged.
*/
const AUTHOR_NAMES: Record<string, string> = {
  tuanha1508: "Anh",
  Dhruv317: "Dhruv",
  hgaddipati1118: "Harsha",
};

/** Human name for a GitHub login, or the login itself when no alias exists. */
export function authorName(login: string): string {
  return AUTHOR_NAMES[login] ?? login;
}

/**
 * Our own teammates' display names. Used when reading a support screenshot, so
 * an internal person in the thread is never mistaken for the customer.
 */
export function internalPeopleNames(): string[] {
  return Object.values(AUTHOR_NAMES);
}

/** The ticket id rides in the meta line, so it is dropped from the title. */
export function displayTitle(item: QueueItem): string {
  const id = item.ticket?.id;
  const title = item.title.trim();
  if (!id) return title;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title
    .replace(new RegExp(`\\s*[([]${esc}[)\\]]\\s*$`, "i"), "")
    .replace(new RegExp(`^${esc}\\s*[:\\-–—]?\\s*`, "i"), "")
    .trim();
}

/**
 * The one line every surface leads with: what the customer reported, in their
 * words. A commit subject is the fallback, never the headline, because the
 * reader of these surfaces is not the person who wrote it.
 */
export function headline(item: QueueItem): string {
  return item.problem?.trim() || displayTitle(item);
}
