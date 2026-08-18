import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { invalidateQueueCache } from "@/lib/queue";

const SIGNATURE_PREFIX = "sha256=";
const ACCEPTED_EVENTS = new Set([
  "pull_request",
  "check_run",
  "pull_request_review_thread",
]);

type GitHubPayload = {
  action?: unknown;
  repository?: {
    full_name?: unknown;
  };
};

function validSignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature?.startsWith(SIGNATURE_PREFIX)) return false;

  const givenHex = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(givenHex)) return false;

  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(givenHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * GitHub cannot present the Merge Desk login cookie, so this route is exempt
 * from proxy auth and authenticates the exact raw request body with GitHub's
 * HMAC signature instead.
 *
 * This receiver deliberately acknowledges quickly. The current webhook side
 * effect is safe and synchronous: invalidate this process's queue cache so its
 * next read goes back to GitHub. Durable event storage / browser fan-out can
 * be added behind the same verified boundary without changing GitHub setup.
 */
export async function POST(request: Request) {
  if (!config.githubWebhookSecret) {
    return Response.json(
      { error: "GITHUB_WEBHOOK_SECRET is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  if (
    !validSignature(
      body,
      request.headers.get("x-hub-signature-256"),
      config.githubWebhookSecret,
    )
  ) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const delivery = request.headers.get("x-github-delivery");

  // GitHub sends a signed ping immediately after a webhook is created.
  if (event === "ping") {
    return Response.json({ ok: true, event, delivery });
  }

  if (!event || !ACCEPTED_EVENTS.has(event)) {
    return Response.json({ ok: true, ignored: true, event, delivery });
  }

  let payload: GitHubPayload;
  try {
    payload = JSON.parse(body) as GitHubPayload;
  } catch {
    return Response.json({ error: "invalid JSON payload" }, { status: 400 });
  }

  const repo =
    typeof payload.repository?.full_name === "string"
      ? payload.repository.full_name
      : null;
  if (!repo || !config.repos.includes(repo)) {
    return Response.json({
      ok: true,
      ignored: true,
      reason: "repository is not in GITHUB_REPOS",
      event,
      delivery,
    });
  }

  invalidateQueueCache();

  return Response.json({
    ok: true,
    event,
    action: typeof payload.action === "string" ? payload.action : null,
    repo,
    delivery,
  });
}
