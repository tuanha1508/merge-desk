import { config } from "./config";

interface Hit {
  email: string;
  name?: string;
}

/**
 * Look up in Supabase users table.
 * Slashy's users table has `email` but no full_name - so we look up by
 * exact email or by email domain (from Linear customer domains).
 */
export async function supabaseLookup(opts: {
  email?: string;
  name?: string;
  domain?: string;
}): Promise<Hit[]> {
  if (!config.supabaseUrl || !config.supabaseKey) return [];

  const base = `${config.supabaseUrl}/rest/v1/${config.supabaseTable}`;
  const emailCol = config.supabaseEmailCol;
  const select = `select=${emailCol}`;

  let filter = "";
  if (opts.email) {
    filter = `${emailCol}=eq.${encodeURIComponent(opts.email)}`;
  } else if (opts.domain) {
    filter = `${emailCol}=ilike.*${encodeURIComponent("@" + opts.domain)}`;
  } else {
    // No name column on users - skip name search.
    return [];
  }

  const res = await fetch(`${base}?${select}&${filter}&limit=5`, {
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
    },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as any[];
  return rows
    .filter((r) => r[emailCol])
    .map((r) => ({ email: r[emailCol] as string }));
}
