import { createHmac, timingSafeEqual } from "node:crypto";
import { authRequired, config } from "./config";

export const SESSION_COOKIE = "mq_session";

const SESSION_MAX_AGE = 14 * 24 * 60 * 60; // seconds
const VERSION = "mq-v1";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so that is checked separately.
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(expiry: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${VERSION}.${expiry}`)
    .digest("hex");
}

/**
 * A signed cookie value rather than the password itself, so a leaked cookie
 * cannot be replayed past its expiry and never reveals what to type.
 */
export function mintSession(): { value: string; maxAge: number } {
  const secret = config.password;
  if (!secret) throw new Error("MQ_PASSWORD is not configured");
  const expiry = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  return { value: `${expiry}.${sign(expiry, secret)}`, maxAge: SESSION_MAX_AGE };
}

export function verifySession(value: string | undefined | null): boolean {
  if (!authRequired()) return true;
  const secret = config.password;
  if (!secret || !value) return false;

  const split = value.indexOf(".");
  if (split <= 0) return false;
  const expiry = Number(value.slice(0, split));
  if (!Number.isInteger(expiry) || expiry * 1000 < Date.now()) return false;

  return equal(value.slice(split + 1), sign(expiry, secret));
}

export function passwordMatches(input: unknown): boolean {
  const secret = config.password;
  if (!secret || typeof input !== "string" || input === "") return false;
  return equal(input, secret);
}

/*
  Shared-password login has no per-user lockout elsewhere, so failed attempts
  are counted here. The bucket is process-local: cold starts and multiple
  serverless instances reset it. That still raises the cost of spraying the
  password on a public URL; pair it with a long password and, in production,
  Vercel Firewall rate limits on /api/login.
*/
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

type AttemptBucket = { failures: number; firstAt: number; lockedUntil: number };
const loginAttempts = new Map<string, AttemptBucket>();

function pruneAttempts(now: number) {
  for (const [key, bucket] of loginAttempts) {
    if (bucket.lockedUntil < now && now - bucket.firstAt > WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}

/** True when this client is temporarily locked out of sign-in. */
export function loginBlocked(clientKey: string): boolean {
  const bucket = loginAttempts.get(clientKey);
  return Boolean(bucket && bucket.lockedUntil > Date.now());
}

/** Record a failed password attempt. Returns whether the client is now locked. */
export function recordLoginFailure(clientKey: string): { locked: boolean } {
  const now = Date.now();
  pruneAttempts(now);
  const existing = loginAttempts.get(clientKey);
  if (existing && existing.lockedUntil > now) {
    return { locked: true };
  }

  if (!existing || now - existing.firstAt > WINDOW_MS) {
    loginAttempts.set(clientKey, {
      failures: 1,
      firstAt: now,
      lockedUntil: 0,
    });
    return { locked: false };
  }

  existing.failures += 1;
  if (existing.failures >= MAX_FAILURES) {
    existing.lockedUntil = now + WINDOW_MS;
    return { locked: true };
  }
  return { locked: false };
}

export function resetLoginFailures(clientKey: string) {
  loginAttempts.delete(clientKey);
}

function cookieFromHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) {
      return decodeURIComponent(part.slice(at + 1).trim());
    }
  }
  return null;
}

/**
 * The single authorisation check for API routes: a signed-in browser, or a
 * machine caller presenting a configured access token. Replaces the previous
 * header-only scheme, which no client ever sent and which therefore let every
 * request through whenever no tokens were configured.
 */
export function authorize(request: Request): boolean {
  if (!authRequired()) return true;

  if (verifySession(cookieFromHeader(request.headers.get("cookie"), SESSION_COOKIE))) {
    return true;
  }

  const token = request.headers.get("x-mq-token");
  return (
    token != null &&
    config.accessTokens.length > 0 &&
    config.accessTokens.some((candidate) => equal(candidate, token))
  );
}
