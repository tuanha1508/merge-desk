import { config } from "./config";

interface Hit {
  email: string;
  name?: string;
}

/**
 * Look up a person in PostHog by email or name.
 * Slashy uses POSTHOG_PERSONAL_API_KEY for the persons query API
 * (project API keys return 401 on /persons/).
 */
export async function posthogLookup(opts: {
  email?: string;
  name?: string;
}): Promise<Hit[]> {
  if (!config.posthogKey || !config.posthogProject) return [];
  const term = opts.email ?? opts.name;
  if (!term) return [];

  const url = `${config.posthogHost}/api/projects/${config.posthogProject}/persons/?search=${encodeURIComponent(
    term,
  )}&limit=5`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.posthogKey}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const json = (await res.json()) as any;
  const results: any[] = json?.results ?? [];
  const hits: Hit[] = [];
  for (const p of results) {
    const email = p?.properties?.email;
    if (typeof email !== "string" || !email) continue;
    const name = p?.properties?.name ?? p?.name;
    hits.push({ email, name: typeof name === "string" ? name : undefined });
  }
  return hits;
}
