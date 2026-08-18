export type EmailSource =
  | "linear"
  | "ticket"
  | "supabase"
  | "posthog"
  | "gmail"
  | "guess"
  | "none";

export interface EmailCandidate {
  email: string;
  source: EmailSource;
  note?: string;
}

export interface CustomerInfo {
  /** Customer / company name, best effort. */
  name: string | null;
  /** Resolved primary email, if we are confident. */
  email: string | null;
  /**
   * A phone number when that is the only contact detail we found - typically
   * read from a chat screenshot where the customer has no email on file.
   */
  phone?: string | null;
  /** Where the email came from. */
  source: EmailSource;
  /** True when we trust the email enough to reach out. */
  verified: boolean;
  /** Alternatives when the lookup was ambiguous. */
  candidates: EmailCandidate[];
  /** Human-readable trail of how we resolved this. */
  trail: string[];
}

/** Linear CRM customer linked via customerNeeds (not the ticket creator). */
export interface LinearCustomer {
  name: string;
  domains: string[];
  /** Emails found in Linear customer externalIds. */
  emails: string[];
  tier: string | null;
}

/**
 * Whoever opened the Linear issue. Not a customer - the internal teammate who
 * filed the work. Used as a fallback face when no customer can be resolved, so
 * a customer-less PR still says who to ask about it.
 */
export interface TicketFiler {
  name: string | null;
  email: string | null;
}

export interface LinearTicket {
  id: string; // e.g. SLA-123
  title: string;
  description: string;
  url: string | null;
  /** Convenience: customer name if linked. */
  customerField: string | null;
  /** Full Linear CRM customer, when linked via customerNeeds. */
  customer: LinearCustomer | null;
  /** The teammate who opened the issue - the fallback when no customer resolves. */
  filedBy: TicketFiler | null;
}

/** A check that has not finished is not a check that failed. */
export type CiState = "passing" | "pending" | "failing";

export interface ReviewGate {
  ciGreen: boolean;
  /** Finer-grained than ciGreen, so "running" never reads as "failing". */
  ciState: CiState;
  /** Unresolved review threads authored by a blocking bot. */
  unresolvedBotReviews: number;
  /** Names of the bots that still have unresolved threads. */
  blockingBots: string[];
}

export interface QueueItem {
  id: string; // `${repo}#${number}`
  repo: string; // owner/repo
  number: number;
  title: string;
  author: string;
  url: string;
  createdAt: string;
  /** Last activity timestamp - what "recent" / "this week" is judged on. */
  updatedAt: string;
  ticket: LinearTicket | null;
  customer: CustomerInfo;
  /** One-line problem summary shown in the row. */
  problem: string;
  gate: ReviewGate;
  /** Final decision: can the Merge button act? */
  mergeable: boolean;
  /** Why merge is blocked, if it is. */
  blockedReason: string | null;
}

export interface MergeResult {
  ok: boolean;
  merged: boolean;
  message: string;
}
