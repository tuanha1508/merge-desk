import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { previewReadyQueue, publishReadyQueue } from "@/lib/slack";

export const maxDuration = 300;

function sameSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  if (!config.slackPublishSecret) {
    return Response.json(
      { error: "SLACK_PUBLISH_SECRET or CRON_SECRET is not configured" },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  const headerSecret = request.headers.get("x-slack-publish-secret");
  if (
    !sameSecret(bearer, config.slackPublishSecret) &&
    !sameSecret(headerSecret, config.slackPublishSecret)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // ?dry=1 returns the cards instead of posting them, so the payload can be
  // reviewed before this endpoint is ever aimed at a real channel.
  const dry = new URL(request.url).searchParams.get("dry") === "1";

  try {
    return Response.json(
      dry ? await previewReadyQueue() : await publishReadyQueue(),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Slack publishing failed",
      },
      { status: 500 },
    );
  }
}

// Vercel Cron invokes routes with GET and the same Authorization header.
export const GET = POST;
