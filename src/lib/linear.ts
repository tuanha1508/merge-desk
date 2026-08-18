import { config } from "./config";
import type { LinearCustomer, LinearTicket, TicketFiler } from "./types";

const LINEAR_API = "https://api.linear.app/graphql";
const REF_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Find a Linear issue reference (e.g. SLA-123) from PR text. */
export function extractTicketRef(...texts: string[]): string | null {
  for (const t of texts) {
    const m = t?.match(REF_RE);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  if (!config.linearApiKey) return null;
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      Authorization: config.linearApiKey,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  if (json?.errors?.length) return null;
  return json?.data as T;
}

/**
 * Fetch a ticket the way Slashy's own linear_ticket.py does it:
 * issue(id) + top-level customerNeeds filtered by issue id.
 * Customer is NOT the ticket creator - it's who reported it.
 */
export async function getTicket(ref: string): Promise<LinearTicket | null> {
  /*
    Issue.needs carries the same customer records as the top-level
    customerNeeds filter, so both arrive in one request. The filtered form
    required the issue's UUID, which forced a second sequential round trip -
    the dominant cost when enriching a page of pull requests.
  */
  const issueData = await gql<{
    issue: {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      url: string | null;
      creator: { name: string | null; displayName: string | null; email: string | null } | null;
      needs: {
        nodes: Array<{
          body: string | null;
          customer: {
            name: string;
            domains: string[] | null;
            externalIds: string[] | null;
            tier: { name: string } | null;
          } | null;
        }>;
      } | null;
    } | null;
  }>(
    `query($id:String!){
      issue(id:$id){
        id identifier title description url
        creator{ name displayName email }
        needs(first:10){
          nodes{
            body
            customer{ name domains externalIds tier{ name } }
          }
        }
      }
    }`,
    { id: ref.toUpperCase() },
  );
  const issue = issueData?.issue;
  if (!issue) return null;

  const filedBy: TicketFiler | null = issue.creator
    ? {
        name: issue.creator.name ?? issue.creator.displayName ?? null,
        email: issue.creator.email ?? null,
      }
    : null;

  const needs = issue.needs?.nodes ?? [];
  const first = needs.find((n) => n.customer)?.customer ?? null;
  const customer: LinearCustomer | null = first
    ? {
        name: first.name,
        domains: first.domains ?? [],
        // externalIds often hold the customer email in Slashy's Linear.
        emails: (first.externalIds ?? []).filter((id) => EMAIL_RE.test(id)),
        tier: first.tier?.name ?? null,
      }
    : null;

  return {
    id: issue.identifier,
    title: issue.title ?? ref,
    description: issue.description ?? "",
    url: issue.url ?? null,
    customerField: customer?.name ?? null,
    customer,
    filedBy,
  };
}
