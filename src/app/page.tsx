import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { getQueue } from "@/lib/queue";
import { Rundown } from "@/components/rundown";

export const dynamic = "force-dynamic";

// Enough rows to make the inbox useful immediately without making first paint
// wait for every ticket/customer lookup in the 50-PR queue.
const INITIAL_ITEMS = 5;

export default async function Page() {
  /*
    The proxy verifies the session cookie signature. The page still re-checks
    here before any queue data is fetched, because this surface renders
    customer names and email addresses straight into the HTML.
  */
  const jar = await cookies();
  if (!verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/login");

  const { mock, items, missingRepos } = await getQueue({
    maxItems: INITIAL_ITEMS,
  });
  return <Rundown items={items} mock={mock} missingRepos={missingRepos} />;
}
