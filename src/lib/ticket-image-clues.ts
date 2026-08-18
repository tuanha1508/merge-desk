import { createHash } from "node:crypto";
import { config } from "./config";

const LINEAR_UPLOAD_HOST = "uploads.linear.app";
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
// A phone as shown in a chat header: optional +, then 7-15 digits with spaces,
// dashes or parentheses between them.
const PHONE_RE = /^\+?[\d][\d\s()\-]{6,18}\d$/;

/** One customer-side contact read from a screenshot. Any field may be absent. */
export interface ImageContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface TicketImageClues {
  contacts: ImageContact[];
}

const EMPTY: TicketImageClues = { contacts: [] };

function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!PHONE_RE.test(trimmed)) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // Keep the human formatting, just collapse runs of whitespace.
  return trimmed.replace(/\s{2,}/g, " ");
}

/**
 * Linear writes screenshots as markdown images, but also sometimes leaves the
 * upload URL bare after an editor conversion. Read both forms, keep only the
 * authenticated Linear upload host, and dedupe in source order.
 */
export function extractLinearImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const matches = markdown.matchAll(/https:\/\/uploads\.linear\.app\/[^\s)"'<>]+/gi);

  for (const match of matches) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(raw);
      if (url.hostname !== LINEAR_UPLOAD_HOST) continue;
      const value = url.toString();
      if (seen.has(value)) continue;
      seen.add(value);
      urls.push(value);
      if (urls.length === MAX_IMAGES) break;
    } catch {
      // A malformed attachment should not prevent the ticket from resolving.
    }
  }
  return urls;
}

type VisionImage = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
};

async function fetchImage(url: string): Promise<VisionImage | null> {
  if (!config.linearApiKey) return null;

  const response = await fetch(url, {
    headers: { Authorization: config.linearApiKey },
    cache: "no-store",
  });
  if (!response.ok) return null;

  const mediaType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!mediaType || !SUPPORTED_TYPES.has(mediaType)) return null;

  const announced = Number(response.headers.get("content-length") ?? "0");
  if (announced > MAX_IMAGE_BYTES) return null;

  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (received === 0) return null;
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as VisionImage["source"]["media_type"],
      data: bytes.toString("base64"),
    },
  };
}

function cleanResult(value: unknown): TicketImageClues {
  if (!value || typeof value !== "object") return EMPTY;
  const raw = value as {
    contacts?: Array<{ name?: unknown; email?: unknown; phone?: unknown }>;
  };

  const contacts: ImageContact[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(raw.contacts) ? raw.contacts : []) {
    const emailRaw =
      typeof row?.email === "string" ? row.email.trim().toLowerCase() : "";
    const email = EMAIL_RE.test(emailRaw) ? emailRaw : null;

    const phone =
      typeof row?.phone === "string" ? normalisePhone(row.phone) : null;

    const name =
      typeof row?.name === "string" && row.name.trim().length <= 100
        ? row.name.trim()
        : null;

    // A contact with nothing reachable and no name is noise.
    if (!email && !phone && !name) continue;

    // Dedupe on the strongest identifier present.
    const key = (email ?? phone ?? name ?? "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    contacts.push({ name, email, phone });
    if (contacts.length === 12) break;
  }

  return { contacts };
}

const cache = new Map<string, Promise<TicketImageClues>>();
const CACHE_LIMIT = 300;
let active = 0;
const waiting: Array<() => void> = [];
const MAX_PARALLEL = 2;

async function withVisionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function inspect(
  urls: string[],
  internalNames: string[],
): Promise<TicketImageClues> {
  if (!config.anthropicKey || !config.linearApiKey || urls.length === 0) {
    return EMPTY;
  }

  const images = (
    await Promise.all(urls.map((url) => fetchImage(url).catch(() => null)))
  ).filter(
    (image): image is VisionImage => image !== null,
  );
  let total = 0;
  const withinBudget = images.filter((image) => {
    const bytes = Math.floor((image.source.data.length * 3) / 4);
    if (total + bytes > MAX_TOTAL_BYTES) return false;
    total += bytes;
    return true;
  });
  if (withinBudget.length === 0) return EMPTY;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 600,
      system:
        "You read support-ticket screenshots (often chat threads) and extract contact details for the CUSTOMER being helped - never our own support staff. Only report what is plainly legible. Never infer, autocomplete, guess, or complete a partial email or number. Return JSON only.",
      messages: [
        {
          role: "user",
          content: [
            ...withinBudget,
            {
              type: "text",
              text: [
                'Return exactly {"contacts":[{"name":"visible name or null","email":"visible email or null","phone":"visible phone or null"}]}.',
                "A contact is a person on the CUSTOMER side of the conversation. In a chat screenshot they are usually the external party, often shown with a phone number.",
                internalNames.length
                  ? `These people are our own support team - never return them as a contact: ${internalNames.join(", ")}.`
                  : "",
                "Include a field only if it is fully legible in the image. Do not complete truncated or partial values. If no customer contact detail is visible, return {\"contacts\":[]}.",
              ]
                .filter(Boolean)
                .join(" "),
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) return EMPTY;

  const body = (await response.json().catch(() => null)) as {
    content?: Array<{ type?: string; text?: string }>;
  } | null;
  const text = body?.content?.find((part) => part.type === "text")?.text;
  if (!text) return EMPTY;

  try {
    return cleanResult(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
  } catch {
    return EMPTY;
  }
}

/**
 * Vision fallback for tickets whose structured fields and prose did not give
 * us a confident customer email. The promise itself is cached so the initial
 * five-row render and the background fill cannot inspect the same images twice.
 */
export function extractTicketImageClues(
  markdown: string,
  internalNames: string[] = [],
): Promise<TicketImageClues> {
  const urls = extractLinearImageUrls(markdown);
  if (urls.length === 0) return Promise.resolve(EMPTY);

  // The excluded team is part of the request, so it belongs in the cache key.
  const key = createHash("sha256")
    .update([...urls, "|", ...internalNames].join("\0"))
    .digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;

  const work = withVisionSlot(() => inspect(urls, internalNames)).catch(
    () => EMPTY,
  );
  cache.set(key, work);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return work;
}
