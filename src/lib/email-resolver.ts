import { config } from "./config";
import type { CustomerInfo, EmailCandidate, LinearTicket } from "./types";
import { supabaseLookup } from "./supabase";
import { posthogLookup } from "./posthog";
import { extractTicketImageClues } from "./ticket-image-clues";
import { internalPeopleNames } from "./display";

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const BAD_EMAIL_EXT = /\.(png|jpe?g|gif|webp|svg|pdf|mov|mp4)$/i;

/** Sender labels that precede a name in an email header or bug report. */
const SENDER_LABEL_RE =
  /^(from|sender|reporter|reported by|customer|client|user|name|account|to|cc|bcc|re)\b[\s:.\-–—]*/i;

const OWN_DOMAINS = new Set(config.ownEmailDomains.map((d) => d.toLowerCase()));
const OWN_NAMES = new Set(config.ownCompanyNames.map((n) => n.toLowerCase()));

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

/** Ours, not a customer's - the vendor side of a support thread. */
function isOwnEmail(email: string): boolean {
  return OWN_DOMAINS.has(domainOf(email));
}

function isOwnName(name: string): boolean {
  return OWN_NAMES.has(name.trim().toLowerCase());
}

/** Every real (non-asset, non-vendor) email in the text, in order. */
function realEmails(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0];
    if (BAD_EMAIL_EXT.test(email)) continue;
    if (isOwnEmail(email)) continue;
    out.push(email);
  }
  return out;
}

/**
 * Pull the display name that sits on the *same line* as a given email.
 * Tying the name to the email's own line is what stops prose like
 * "...from Slashy's own telemetry..." from being read as a customer name -
 * that sentence carries no email, so it is never consulted.
 */
function nameOnEmailLine(text: string, email: string): string | null {
  const line =
    text.split(/\r?\n/).find((l) => l.includes(email)) ?? "";
  const before = line.slice(0, line.indexOf(email));

  const cleaned = before
    .replace(/[*_`>~]/g, " ") // markdown emphasis / quote marks
    .replace(/\([^)]*\)/g, " ") // titles: "(Chief of Staff)"
    .replace(/[()<>[\]{}"'|,;]/g, " ") // stray brackets and punctuation
    .replace(/\s+/g, " ")
    .trim()
    .replace(SENDER_LABEL_RE, "") // drop a leading "From:" / "User:" etc.
    .trim();

  // The name hugs the email, so anchor the match to the end of what remains.
  const m = cleaned.match(
    /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\s*$/,
  );
  const name = m?.[1]?.trim() ?? null;
  if (!name || isOwnName(name)) return null;
  return name;
}

interface Reporter {
  email: string | null;
  name: string | null;
}

/** The reachable reporter (email + adjacent name) named in the ticket text. */
function reporterFromText(text: string): Reporter {
  const email = realEmails(text)[0] ?? null;
  return {
    email,
    name: email ? nameOnEmailLine(text, email) : null,
  };
}

/** "Andrew - Align" → ["Andrew - Align", "Andrew"] for PostHog search. */
function nameVariants(name: string): string[] {
  const out = [name];
  const beforeDash = name.split(/\s[-–—]\s/)[0]?.trim();
  if (beforeDash && beforeDash.toLowerCase() !== name.toLowerCase()) {
    out.push(beforeDash);
  }
  return out;
}

interface Clues {
  email: string | null;
  name: string | null;
}

/** Pull clues from Linear CRM customer + ticket body. */
export function extractClues(ticket: LinearTicket | null): Clues {
  const linkedEmail = ticket?.customer?.emails?.[0] ?? null;
  // A linked customer named after our own company is not a real customer.
  const rawLinkedName = ticket?.customer?.name ?? null;
  const linkedName =
    rawLinkedName && !isOwnName(rawLinkedName) ? rawLinkedName : null;

  const text = [ticket?.title, ticket?.description].filter(Boolean).join("\n");
  // Name and email come from the same line, so they describe the same person.
  const reporter = reporterFromText(text);

  return {
    email: linkedEmail ?? reporter.email,
    name: linkedName ?? reporter.name,
  };
}

/**
 * Resolve customer email:
 *   Linear customer externalIds → ticket email → PostHog by name →
 *   Supabase by email / domain → candidates if ambiguous.
 * Never invents an unseen address.
 */
export async function resolveCustomer(
  ticket: LinearTicket | null,
): Promise<CustomerInfo> {
  const trail: string[] = [];
  const clues = extractClues(ticket);
  let name = clues.name;
  let phone: string | null = null;
  const domains = ticket?.customer?.domains ?? [];

  // 1. Linear CRM customer already has an email in externalIds.
  if (ticket?.customer?.emails?.length) {
    const email = ticket.customer.emails[0];
    const linkedName = isOwnName(ticket.customer.name)
      ? null
      : ticket.customer.name;
    trail.push(`linear customer "${ticket.customer.name}" externalId`);
    return {
      name: linkedName,
      email,
      source: "linear",
      verified: true,
      candidates: [],
      trail,
    };
  }

  // 2. Email printed in the ticket body.
  if (clues.email) {
    trail.push("email found in ticket text");
    return {
      name,
      email: clues.email,
      source: "ticket",
      verified: true,
      candidates: [],
      trail,
    };
  }

  const candidates: EmailCandidate[] = [];

  // PostHog persons search by name, tried across "Andrew - Align" and "Andrew".
  // Factored out so a name discovered later (in a screenshot) can be looked up
  // the same way as a name we started with.
  async function lookupByName(searchName: string): Promise<void> {
    for (const variant of nameVariants(searchName)) {
      try {
        const rows = await posthogLookup({ name: variant });
        for (const r of rows) {
          candidates.push({ email: r.email, source: "posthog", note: r.name });
        }
        if (rows.length) {
          trail.push(`posthog "${variant}": ${rows.length}`);
          return; // first variant that hits is enough
        }
      } catch {
        trail.push(`posthog "${variant}" errored`);
      }
    }
  }

  if (name) trail.push(`customer name: "${name}"`);
  if (domains.length) trail.push(`domains: ${domains.join(", ")}`);

  // 3. PostHog by name.
  if (name) await lookupByName(name);

  // 4. Supabase by domain (users table has email, not full_name).
  for (const domain of domains.slice(0, 2)) {
    try {
      const rows = await supabaseLookup({ domain });
      for (const r of rows) {
        candidates.push({ email: r.email, source: "supabase", note: domain });
      }
      if (rows.length) trail.push(`supabase @${domain}: ${rows.length}`);
    } catch {
      trail.push(`supabase @${domain} errored`);
    }
  }

  // If PostHog gave us a single email, also verify it exists in Supabase.
  if (candidates.length === 1) {
    try {
      const rows = await supabaseLookup({ email: candidates[0].email });
      if (rows.length) trail.push("supabase confirmed email");
    } catch {
      /* ignore */
    }
  }

  /*
    A single backend result, or one exact Linear-domain match, is already a
    confident answer. Stop here instead of downloading screenshots and paying
    for vision on tickets the existing resolver can handle.
  */
  const backendUnique = dedupe(candidates);
  const domainSet = new Set(domains.map((d) => d.toLowerCase()));
  const backendDomainMatched = domainSet.size
    ? backendUnique.filter((candidate) =>
        domainSet.has(domainOf(candidate.email)),
      )
    : [];
  const backendPick =
    backendDomainMatched.length === 1
      ? backendDomainMatched[0]
      : backendUnique.length === 1
        ? backendUnique[0]
        : null;
  if (backendPick) {
    if (backendDomainMatched.length === 1) {
      trail.push(`picked @${domainOf(backendPick.email)} match`);
    }
    return {
      name,
      email: backendPick.email,
      source: backendPick.source,
      verified: true,
      candidates: [],
      trail,
    };
  }

  /*
    Screenshots are the final fallback, read only for tickets the structured
    fields and prose could not resolve. We ask specifically for the customer
    side and pass our own team's names so an internal person in a chat thread
    is never taken as the contact.
  */
  const internalNames = new Set(
    [
      ...config.ownCompanyNames,
      ...internalPeopleNames(),
      ticket?.filedBy?.name ?? "",
    ]
      .filter(Boolean)
      .map((n) => n.trim().toLowerCase()),
  );
  const isInternalName = (value: string | null): boolean =>
    !!value && (isOwnName(value) || internalNames.has(value.trim().toLowerCase()));

  const imageClues = await extractTicketImageClues(
    ticket?.description ?? "",
    [...internalNames],
  );
  const externalContacts = imageClues.contacts.filter(
    (contact) =>
      !isInternalName(contact.name) &&
      (contact.email ? !isOwnEmail(contact.email) : true),
  );

  const imageEmails = externalContacts.filter(
    (contact): contact is typeof contact & { email: string } =>
      Boolean(contact.email) && !isOwnEmail(contact.email!),
  );
  for (const contact of imageEmails) {
    candidates.push({
      email: contact.email,
      source: "ticket",
      note:
        contact.name && !isInternalName(contact.name)
          ? contact.name
          : "Ticket screenshot",
    });
  }
  if (imageEmails.length > 0) {
    trail.push(
      `${imageEmails.length} email${imageEmails.length === 1 ? "" : "s"} found in ticket screenshot${imageEmails.length === 1 ? "" : "s"}`,
    );
  }

  // A name or phone read from the screenshot, when we had none. A newly found
  // name is looked up the same way an original name would have been, so the
  // screenshot can still yield an email even when it only showed a face.
  const namedContact = externalContacts.find((contact) => contact.name);
  if (!name && namedContact?.name) {
    name = namedContact.name;
    trail.push(`customer name found in ticket screenshot: "${name}"`);
    await lookupByName(name);
  }
  const phoneContact = externalContacts.find((contact) => contact.phone);
  if (phoneContact?.phone) {
    phone = phoneContact.phone;
    trail.push("phone found in ticket screenshot");
  }

  const unique = dedupe(candidates);

  // Prefer candidates whose email domain matches Linear customer domains.
  const domainMatched = domainSet.size
    ? unique.filter((c) =>
        domainSet.has(c.email.split("@")[1]?.toLowerCase() ?? ""),
      )
    : [];
  const ranked =
    domainMatched.length > 0
      ? [
          ...domainMatched,
          ...unique.filter((c) => !domainMatched.includes(c)),
        ]
      : unique;

  // Exact domain match → confident enough to pick without a human.
  if (domainMatched.length === 1) {
    trail.push(`picked @${domains[0]} match`);
    return {
      name,
      email: domainMatched[0].email,
      phone,
      source: domainMatched[0].source,
      verified: true,
      candidates: [],
      trail,
    };
  }

  if (ranked.length === 1) {
    return {
      name,
      email: ranked[0].email,
      phone,
      source: ranked[0].source,
      verified: true,
      candidates: [],
      trail,
    };
  }

  if (ranked.length > 1) {
    trail.push(`${ranked.length} candidates - needs a pick`);
    return {
      name,
      email: null,
      phone,
      source: ranked[0].source,
      verified: false,
      candidates: ranked.slice(0, 5),
      trail,
    };
  }

  // No email anywhere, but a name or phone from the screenshot is still a real
  // customer contact - far better than falling back to the internal filer.
  if (phone) {
    trail.push("no email - phone only");
    return {
      name,
      email: null,
      phone,
      source: "ticket",
      verified: false,
      candidates: [],
      trail,
    };
  }

  trail.push("no backend match");
  return {
    name,
    email: null,
    phone,
    source: "none",
    verified: false,
    candidates: [],
    trail,
  };
}

function dedupe(list: EmailCandidate[]): EmailCandidate[] {
  const seen = new Map<string, EmailCandidate>();
  for (const c of list) {
    const key = c.email.toLowerCase();
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}
