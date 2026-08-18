import { authorize } from "@/lib/auth";
import { config } from "@/lib/config";

/**
 * Linear's uploads.linear.app assets 404 without an Authorization header,
 * so the browser can't load them directly. Proxy them with the key attached.
 */
export async function GET(request: Request) {
  if (!authorize(request)) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = new URL(request.url).searchParams.get("url");
  if (!url) return new Response("url required", { status: 400 });

  // Only ever proxy Linear uploads.
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (target.hostname !== "uploads.linear.app") {
    return new Response("forbidden host", { status: 403 });
  }
  if (!config.linearApiKey) {
    return new Response("linear key not configured", { status: 503 });
  }

  const upstream = await fetch(target.toString(), {
    headers: { Authorization: config.linearApiKey },
    cache: "no-store",
  });
  if (!upstream.ok || !upstream.body) {
    return new Response("asset unavailable", { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/png",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
