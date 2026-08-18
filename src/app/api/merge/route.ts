import { authorize } from "@/lib/auth";
import { mergeQueueItem } from "@/lib/merge";

export async function POST(request: Request) {
  if (!authorize(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    repo?: string;
    number?: number;
  };
  if (!body.repo || !body.number) {
    return Response.json({ error: "repo and number required" }, { status: 400 });
  }

  const { result, status } = await mergeQueueItem(body.repo, body.number);
  return Response.json(result, { status });
}
