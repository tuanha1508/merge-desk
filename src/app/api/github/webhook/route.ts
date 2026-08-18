import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import {
  applyWebhookEvent,
  invalidateQueueCache,
  type WebhookEvent,
} from "@/lib/queue";

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
  pull_request?: {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    state?: unknown;
    draft?: unknown;
    merged?: unknown;
    head?: { ref?: unknown };
    user?: { login?: unknown };
  };
  check_run?: {
    pull_requests?: Array<{ number?: unknown }>;
  };
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * Pull the target PR out of whichever event shape carries it. pull_request and
 * review-thread events nest a full `pull_request`; check_run events only list
 * the PR numbers the run belongs to.
 */
function prFromPayload(payload: GitHubPayload): WebhookEvent["pr"] {
  const p = payload.pull_request;
  const number = int(p?.number);
  if (p && number !== undefined) {
    return {
      number,
      title: str(p.title),
      author: str(p.user?.login),
      url: str(p.html_url),
      createdAt: str(p.created_at),
      updatedAt: str(p.updated_at),
      headRef: str(p.head?.ref),
      state: str(p.state),
      draft: typeof p.draft === "boolean" ? p.draft : undefined,
      merged: typeof p.merged === "boolean" ? p.merged : undefined,
    };
  }

  const fromCheck = payload.check_run?.pull_requests?.find(
    (entry) => int(entry?.number) !== undefined,
  );
  const checkNumber = int(fromCheck?.number);
  if (checkNumber !== undefined) return { number: checkNumber };

  return null;
}

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

  const action = str(payload.action) ?? null;

  /*
    Patch the cache straight from the payload so the change is visible on the
    next read: closed PRs drop out, new/edited PRs are (re)built, and CI or
    review-thread events refresh only the affected gate. Any failure downgrades
    to a plain cache clear so the next fetch simply rebuilds from GitHub, and we
    still acknowledge with 200 so GitHub does not retry a delivery we received.
  */
  let outcome: Awaited<ReturnType<typeof applyWebhookEvent>>;
  try {
    outcome = await applyWebhookEvent({
      event: event as WebhookEvent["event"],
      action,
      repo,
      pr: prFromPayload(payload),
    });
  } catch (error) {
    invalidateQueueCache();
    outcome = {
      patched: false,
      action: "skipped",
      detail: error instanceof Error ? error.message : "apply failed",
    };
  }

  return Response.json({
    ok: true,
    event,
    action,
    repo,
    delivery,
    patched: outcome.patched,
    patch: outcome.action,
    detail: outcome.detail,
  });
}
