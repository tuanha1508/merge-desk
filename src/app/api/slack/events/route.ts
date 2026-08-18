import { getSlackBot } from "@/lib/slack";

/**
 * Slack sends interactive button payloads here. Chat SDK verifies the Slack
 * signature and timestamp before dispatching the action handler.
 */
export function POST(request: Request) {
  try {
    return getSlackBot().webhooks.slack(request);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Slack is not configured",
      },
      { status: 503 },
    );
  }
}
