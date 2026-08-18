import { authorize } from "@/lib/auth";
import { getPullRequestContext } from "@/lib/github";
import { summarizeForBoss } from "@/lib/summarize";

/**
 * Lazy: the boss update is generated when a row is opened, not for
 * every PR on page load.
 */
export async function POST(request: Request) {
  if (!authorize(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    key?: string;
    repo?: string;
    number?: number;
    ticketTitle?: string;
    ticketBody?: string;
    prTitle?: string;
  };

  if (!body.key || !body.prTitle) {
    return Response.json({ error: "key and prTitle required" }, { status: 400 });
  }

  /*
    The description and touched paths are read here rather than accepted from
    the client: they are the evidence the model is told to stay grounded in,
    so they have to come from GitHub, not from whoever called this route.
  */
  let prBody = "";
  let changedFiles: string[] = [];
  if (body.repo && typeof body.number === "number") {
    try {
      const ctx = await getPullRequestContext(body.repo, body.number);
      prBody = ctx.body;
      changedFiles = ctx.files;
    } catch {
      // Evidence is an enhancement; the summary still works without it.
    }
  }

  const summary = await summarizeForBoss({
    key: body.key,
    ticketTitle: body.ticketTitle ?? "",
    ticketBody: body.ticketBody ?? "",
    prTitle: body.prTitle,
    prBody,
    changedFiles,
  });

  if (!summary) {
    return Response.json(
      { error: "summary unavailable - check ANTHROPIC_API_KEY" },
      { status: 503 },
    );
  }
  return Response.json({ summary });
}
