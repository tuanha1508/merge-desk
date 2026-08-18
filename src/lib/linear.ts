import { config } from "./config";
import type { LinearCustomer, LinearTicket, TicketFiler } from "./types";

const LINEAR_API = "https://api.linear.app/graphql";
const REF_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** How many issue aliases to pack into one Linear GraphQL request. */
const TICKET_BATCH = 20;

const ISSUE_FIELDS = `
  id identifier title description url
  creator{ name displayName email }
  needs(first:10){
    nodes{
      body
      customer{ name domains externalIds tier{ name } }
    }
  }
`;

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  creator: {
    name: string | null;
    displayName: string | null;
    email: string | null;
  } | null;
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
};

/** Find a Linear issue reference (e.g. SLA-123) from PR text. */
export function extractTicketRef(...texts: string[]): string | null {
  for (const t of texts) {
    const m = t?.match(REF_RE);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
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

function parseIssue(issue: IssueNode, fallbackRef: string): LinearTicket {
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
    title: issue.title ?? fallbackRef,
    description: issue.description ?? "",
    url: issue.url ?? null,
    customerField: customer?.name ?? null,
    customer,
    filedBy,
  };
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
  const issueData = await gql<{ issue: IssueNode | null }>(
    `query($id:String!){
      issue(id:$id){${ISSUE_FIELDS}}
    }`,
    { id: ref.toUpperCase() },
  );
  const issue = issueData?.issue;
  if (!issue) return null;
  return parseIssue(issue, ref);
}

/**
 * Resolve many ticket refs in a handful of aliased GraphQL requests instead of
 * one round trip per PR. Missing refs are simply absent from the map.
 */
export async function getTickets(
  refs: string[],
): Promise<Map<string, LinearTicket>> {
  const out = new Map<string, LinearTicket>();
  const unique = [
    ...new Set(
      refs.map((ref) => ref.toUpperCase()).filter((ref) => REF_RE.test(ref)),
    ),
  ];
  if (unique.length === 0 || !config.linearApiKey) return out;

  for (let i = 0; i < unique.length; i += TICKET_BATCH) {
    const chunk = unique.slice(i, i + TICKET_BATCH);
    const varDecls = chunk.map((_, index) => `$id${index}:String!`).join(",");
    const selections = chunk
      .map((_, index) => `i${index}: issue(id:$id${index}){${ISSUE_FIELDS}}`)
      .join("\n");
    const variables: Record<string, string> = {};
    chunk.forEach((ref, index) => {
      variables[`id${index}`] = ref;
    });

    const data = await gql<Record<string, IssueNode | null>>(
      `query(${varDecls}){${selections}}`,
      variables,
    );
    if (!data) continue;
    chunk.forEach((ref, index) => {
      const issue = data[`i${index}`];
      if (issue) out.set(ref, parseIssue(issue, ref));
    });
  }

  return out;
}
