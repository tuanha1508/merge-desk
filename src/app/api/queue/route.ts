import { authorize } from "@/lib/auth";
import { getQueue, refreshQueueGates } from "@/lib/queue";

export async function GET(request: Request) {
  if (!authorize(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");
    const allowVision = url.searchParams.get("vision") === "1";

    // Gates mode reuses Linear/customer enrichment and only refreshes CI + bot
    // threads from GitHub. Full mode rebuilds everything; vision opts into the
    // screenshot waterfall for unresolved customers ("Search again").
    const data =
      mode === "gates" && !allowVision
        ? await refreshQueueGates()
        : await getQueue({ allowVision });

    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "failed to load queue" },
      { status: 500 },
    );
  }
}
