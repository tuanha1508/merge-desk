import { config } from "@/lib/config";
import {
  SESSION_COOKIE,
  mintSession,
  passwordMatches,
  recordLoginFailure,
  resetLoginFailures,
  loginBlocked,
} from "@/lib/auth";

/**
 * Only same-origin relative paths. Protocol-relative (`//evil`) and backslash
 * tricks both pass a naive "starts with /" check and resolve off-origin.
 */
function safeNext(raw: string | undefined, requestUrl: string): string {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\")
  ) {
    return "/";
  }
  try {
    const origin = new URL(requestUrl).origin;
    const destination = new URL(raw, origin);
    if (destination.origin !== origin) return "/";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function lockedRedirect(requestUrl: string, next: string) {
  const retry = new URL("/login", requestUrl);
  retry.searchParams.set("error", "locked");
  if (next !== "/") retry.searchParams.set("next", next);
  return Response.redirect(retry, 303);
}

export async function POST(request: Request) {
  if (!config.password) {
    return Response.json(
      { error: "MQ_PASSWORD is not configured on this deployment" },
      { status: 503 },
    );
  }

  const form = await request.formData().catch(() => null);
  const next = safeNext(
    typeof form?.get("next") === "string" ? String(form.get("next")) : undefined,
    request.url,
  );

  const key = clientKey(request);
  if (loginBlocked(key)) {
    return lockedRedirect(request.url, next);
  }

  if (!passwordMatches(form?.get("password"))) {
    const { locked } = recordLoginFailure(key);
    if (locked) return lockedRedirect(request.url, next);
    const retry = new URL("/login", request.url);
    retry.searchParams.set("error", "1");
    if (next !== "/") retry.searchParams.set("next", next);
    return Response.redirect(retry, 303);
  }

  resetLoginFailures(key);
  const session = mintSession();
  const destination = new URL(next, request.url);
  const cookie = [
    `${SESSION_COOKIE}=${session.value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${session.maxAge}`,
    process.env.NODE_ENV === "production" ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");

  // Built by hand rather than with Response.redirect, whose headers are
  // immutable - the cookie cannot be attached to one.
  return new Response(null, {
    status: 303,
    headers: { location: destination.toString(), "set-cookie": cookie },
  });
}
