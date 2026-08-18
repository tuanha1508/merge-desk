import { authorize } from "@/lib/auth";
import { getQueue } from "@/lib/queue";

export async function GET(request: Request) {
  if (!authorize(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const data = await getQueue();
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "failed to load queue" },
      { status: 500 },
    );
  }
}
