import type { QueueItem } from "./types";

/**
 * Fake queue so the app runs with zero credentials.
 *
 * Safe for a public repo / portfolio screenshots: every customer, ticket, and
 * bot review is invented. No real company, no real emails, no Slashy staff.
 */
export const mockQueue: QueueItem[] = [
  {
    id: "acme-labs/api#482",
    repo: "acme-labs/api",
    number: 482,
    title: "Login fails after password reset on mobile",
    author: "maya",
    url: "https://github.com/acme-labs/api/pull/482",
    createdAt: "2026-08-16T09:12:00Z",
    updatedAt: "2026-08-17T08:40:00Z",
    ticket: {
      id: "ENG-311",
      title: "Login fails after password reset on mobile",
      description:
        "Customer Jane Doe (Northwind Retail) reports that after resetting their password from the iOS app, they land on a blank screen and can't sign in. Reproduced on iOS 18.2, app 4.3.1. Desktop web works fine. They need this fixed before Monday's board demo.",
      url: "https://linear.app/acme-labs/issue/ENG-311",
      customerField: "Northwind Retail",
      customer: {
        name: "Northwind Retail",
        domains: ["northwind.example"],
        emails: ["jane@northwind.example"],
        tier: null,
      },
      filedBy: { name: "Maya Chen", email: "maya@acme-labs.example" },
    },
    customer: {
      name: "Northwind Retail",
      email: "jane@northwind.example",
      source: "linear",
      verified: true,
      candidates: [],
      trail: ["email found in ticket text"],
    },
    problem: "After reset on iOS they hit a blank screen and can't sign in.",
    gate: {
      ciGreen: true,
      ciState: "passing",
      unresolvedBotReviews: 0,
      blockingBots: [],
    },
    mergeable: true,
    blockedReason: null,
  },
  {
    id: "acme-labs/web#91",
    repo: "acme-labs/web",
    number: 91,
    title: "Billing webhook retry loop",
    author: "jordan",
    url: "https://github.com/acme-labs/web/pull/91",
    createdAt: "2026-08-16T14:03:00Z",
    updatedAt: "2026-08-16T18:20:00Z",
    ticket: {
      id: "ENG-402",
      title: "Duplicate invoices from webhook retries",
      description:
        "Globex saw duplicate invoices when our billing webhook retried on timeout. Need idempotency keys on the handler.\n\n**Claude review (unresolved):**\n> This handler can still double-charge if two retries land in the same second. Add an idempotency key on `invoice_id` before inserting.",
      url: "https://linear.app/acme-labs/issue/ENG-402",
      customerField: null,
      customer: null,
      filedBy: { name: "Jordan Lee", email: "jordan@acme-labs.example" },
    },
    customer: {
      name: "Sam Ortiz",
      email: "sam@globex.example",
      source: "supabase",
      verified: true,
      candidates: [],
      trail: ['name in ticket: "Sam Ortiz"', "supabase: 1 match"],
    },
    problem: "Duplicate invoices from webhook retries - needs idempotency.",
    gate: {
      ciGreen: true,
      ciState: "passing",
      unresolvedBotReviews: 2,
      blockingBots: ["claude[bot]"],
    },
    mergeable: false,
    blockedReason: "2 unresolved bot reviews (claude[bot])",
  },
  {
    id: "acme-labs/api#488",
    repo: "acme-labs/api",
    number: 488,
    title: "Add rate limit to export endpoint",
    author: "maya",
    url: "https://github.com/acme-labs/api/pull/488",
    createdAt: "2026-08-17T02:40:00Z",
    updatedAt: "2026-08-17T05:10:00Z",
    ticket: {
      id: "ENG-410",
      title: "Export endpoint abused by a script",
      description:
        "A user hammered the export endpoint overnight. Add a per-user rate limit. Reporter only left a first name in the thread: 'Priya'.",
      url: "https://linear.app/acme-labs/issue/ENG-410",
      customerField: null,
      customer: null,
      filedBy: { name: "Maya Chen", email: "maya@acme-labs.example" },
    },
    customer: {
      name: "Priya",
      email: null,
      source: "posthog",
      verified: false,
      candidates: [
        { email: "priya@contoso.example", source: "posthog", note: "Priya Nair" },
        {
          email: "priya.n@contoso.example",
          source: "supabase",
          note: "Priya N.",
        },
      ],
      trail: ['name in ticket: "Priya"', "2 candidates - needs a pick"],
    },
    problem: "Export endpoint abused - add per-user rate limit.",
    gate: {
      ciGreen: false,
      ciState: "failing",
      unresolvedBotReviews: 0,
      blockingBots: [],
    },
    mergeable: false,
    blockedReason: "CI not green",
  },
];
