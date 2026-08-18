import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE = "mq_session";

/*
  Token format is defined in lib/auth.ts, but is re-implemented here on Web
  Crypto rather than imported: this file has to run on the edge runtime, where
  node:crypto is unavailable. Kept in sync with VERSION there.
*/
const VERSION = "mq-v1";

async function expectedSignature(
  expiry: number,
  secret: string,
): Promise<string> {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    bytes.encode(`${VERSION}.${expiry}`),
  );
  return Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function valid(value: string | undefined, secret: string) {
  if (!value) return false;
  const split = value.indexOf(".");
  if (split <= 0) return false;

  const expiry = Number(value.slice(0, split));
  if (!Number.isInteger(expiry) || expiry * 1000 < Date.now()) return false;

  const given = value.slice(split + 1);
  const expected = await expectedSignature(expiry, secret);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/*
  The gate that keeps unauthenticated traffic off the server-rendered queue.
  Because the route streams a loading shell, an in-page redirect would still
  flush a 200 and its skeleton before the redirect reached the browser, so the
  signature is checked here, before rendering begins. The page and the API
  routes verify it again in Node - this is the first line, not the only one.
*/
export async function proxy(request: NextRequest) {
  const secret = process.env.MQ_PASSWORD;
  if (!secret) {
    // Nothing configured: open locally, closed once deployed.
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
  } else if (await valid(request.cookies.get(SESSION_COOKIE)?.value, secret)) {
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const login = new URL("/login", request.url);
  // Come back to whatever was being asked for after signing in.
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    /*
      Everything except: the sign-in page and its endpoint, Slack's two routes,
      GitHub's webhook receiver, and static assets. External services cannot
      present our login cookie; each exempt endpoint verifies its own secret.
    */
    "/((?!login|api/login|api/slack|api/github/webhook|_next/static|_next/image|icon.png|favicon.ico).*)",
  ],
};
