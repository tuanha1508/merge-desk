"use client";

import { useState } from "react";
import type { CustomerInfo, QueueItem } from "@/lib/types";
import { authorName } from "@/lib/display";
import { TicketMarkdown } from "./ticket-markdown";
import { BossUpdate } from "./boss-update";

export function QueueTable({ items }: { items: QueueItem[] }) {
  if (items.length === 0) {
    return (
      <p className="mt-10 border-t border-rule py-16 text-center font-display text-2xl text-muted">
        Nothing filed. The queue is clear.
      </p>
    );
  }
  return (
    <ul>
      {items.map((item) => (
        <Row key={item.id} item={item} />
      ))}
    </ul>
  );
}

type Status = "ready" | "hold" | "failing" | "merged";

function statusOf(item: QueueItem, merged: boolean): Status {
  if (merged) return "merged";
  if (!item.gate.ciGreen) return "failing";
  if (item.gate.unresolvedBotReviews > 0) return "hold";
  return "ready";
}

function Row({ item }: { item: QueueItem }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "merging" | "merged" | "error">(
    "idle",
  );
  const [msg, setMsg] = useState<string | null>(null);

  const merged = state === "merged";
  const status = statusOf(item, merged);

  async function merge() {
    setState("merging");
    setMsg(null);
    try {
      const res = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: item.repo, number: item.number }),
      });
      const data = await res.json();
      if (res.ok && data.merged) {
        setState("merged");
        setMsg(data.message);
      } else {
        setState("error");
        setMsg(data.message ?? "Merge failed");
      }
    } catch {
      setState("error");
      setMsg("Network error");
    }
  }

  const repoName = item.repo.split("/")[1] ?? item.repo;

  return (
    <li
      className={
        "border-t border-rule transition-opacity first:border-t-2 first:border-ink " +
        (merged ? "opacity-55" : "")
      }
    >
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 py-7 md:grid-cols-[6.5rem_minmax(0,1fr)_14rem] md:items-start lg:grid-cols-[6.5rem_minmax(0,1fr)_14rem_11rem]">
        {/* Stamp */}
        <div className="md:pt-1">
          <Stamp status={status} />
        </div>

        {/* Report: headline, dateline, deck */}
        <div className="min-w-0">
          <h2 className="font-display text-[21px] font-medium leading-snug tracking-[-0.01em] text-ink">
            {item.title}
          </h2>
          <p className="mt-1 text-[12.5px] text-muted">
            <span className="text-ink-soft">{repoName}</span>
            <Dot />#{item.number}
            <Dot />@{authorName(item.author)}
            {item.ticket && (
              <>
                <Dot />
                <span className="text-ink-soft">{item.ticket.id}</span>
              </>
            )}
          </p>

          <p className="mt-2.5 max-w-[46ch] font-display text-[16px] italic leading-relaxed text-ink-soft">
            {item.problem}
          </p>

          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="mt-2 text-[12px] font-medium text-accent underline decoration-accent/30 underline-offset-4 transition hover:decoration-accent"
          >
            {open ? "Close report" : "Read the report"}
          </button>
        </div>

        {/* Customer byline */}
        <div className="min-w-0">
          <Customer customer={item.customer} />
        </div>

        {/* Actions */}
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="flex items-center gap-2.5">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] text-muted underline decoration-rule-strong underline-offset-4 transition hover:text-ink hover:decoration-ink"
            >
              View PR
            </a>
            <button
              onClick={merge}
              disabled={!item.mergeable || state === "merging" || merged}
              title={item.blockedReason ?? "Squash merge"}
              className={
                "rounded-[3px] px-4 py-1.5 text-[13px] font-medium transition " +
                (merged
                  ? "bg-ink/10 text-ink-soft"
                  : item.mergeable
                    ? "bg-accent text-paper hover:bg-accent-2"
                    : "cursor-not-allowed border border-rule-strong text-faint")
              }
            >
              {state === "merging" ? "Merging…" : merged ? "Merged" : "Merge"}
            </button>
          </div>

          {msg ? (
            <p
              className={
                "max-w-[15rem] text-right text-[12px] " +
                (state === "error" ? "text-stop" : "text-accent")
              }
            >
              {msg}
            </p>
          ) : (
            item.blockedReason && (
              <p className="max-w-[15rem] text-right text-[12px] text-hold">
                {item.blockedReason}
              </p>
            )
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-rule bg-paper-2/60">
          <div className="grid gap-x-10 gap-y-8 px-1 py-8 md:px-0 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <article className="min-w-0 md:pl-[calc(6.5rem+2rem)]">
              <p className="font-sans text-[11px] uppercase tracking-[0.24em] text-faint">
                {item.ticket ? `${item.ticket.id} — the ticket` : "Pull request"}
              </p>
              {item.ticket?.title && (
                <h3 className="mt-2 font-display text-[22px] font-medium leading-snug">
                  {item.ticket.title}
                </h3>
              )}
              <div className="mt-4">
                <TicketMarkdown body={item.ticket?.description ?? ""} />
              </div>
              {item.ticket?.url && (
                <a
                  href={item.ticket.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-5 inline-block text-[12.5px] text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent"
                >
                  Open in Linear ↗
                </a>
              )}
            </article>

            <aside className="space-y-6 md:pr-6">
              <BossUpdate item={item} />
              <Trail customer={item.customer} blockedReason={item.blockedReason} />
            </aside>
          </div>
        </div>
      )}
    </li>
  );
}

function Dot() {
  return <span className="mx-1.5 text-rule-strong">·</span>;
}

function Stamp({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string }> = {
    ready: { label: "Ready", cls: "border-accent text-accent" },
    hold: { label: "Hold", cls: "border-hold text-hold" },
    failing: { label: "Failing", cls: "border-stop text-stop" },
    merged: { label: "Merged", cls: "border-ink/30 text-ink-soft" },
  };
  const { label, cls } = map[status];
  return (
    <span
      className={
        "inline-block -rotate-2 border px-2.5 py-1 font-sans text-[10px] font-semibold uppercase tracking-[0.18em] " +
        cls
      }
    >
      {label}
    </span>
  );
}

function Customer({ customer }: { customer: CustomerInfo }) {
  return (
    <div className="min-w-0">
      <p className="font-sans text-[11px] uppercase tracking-[0.2em] text-faint">
        Customer
      </p>

      {customer.email ? (
        <div className="mt-1.5">
          {customer.name && (
            <p className="truncate font-display text-[17px] leading-tight">
              {customer.name}
            </p>
          )}
          <a
            href={`mailto:${customer.email}`}
            className="mt-0.5 block truncate text-[13px] text-accent underline decoration-accent/25 underline-offset-2 hover:decoration-accent"
          >
            {customer.email}
          </a>
          <p className="mt-0.5 text-[11px] text-muted">via {customer.source}</p>
        </div>
      ) : customer.candidates.length > 0 ? (
        <div className="mt-1.5">
          {customer.name && (
            <p className="truncate font-display text-[17px] leading-tight">
              {customer.name}
            </p>
          )}
          <ul className="mt-1 space-y-0.5">
            {customer.candidates.slice(0, 2).map((c) => (
              <li key={c.email} className="truncate text-[12.5px] text-ink-soft">
                {c.email}
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-[11px] text-hold">
            {customer.candidates.length} to confirm
          </p>
        </div>
      ) : customer.name ? (
        <div className="mt-1.5">
          <p className="truncate font-display text-[17px] leading-tight">
            {customer.name}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">no email on file</p>
        </div>
      ) : (
        <p className="mt-1.5 text-[13px] text-faint">Not linked</p>
      )}
    </div>
  );
}

function Trail({
  customer,
  blockedReason,
}: {
  customer: CustomerInfo;
  blockedReason: string | null;
}) {
  return (
    <section>
      <p className="font-sans text-[11px] uppercase tracking-[0.24em] text-faint">
        How we found the customer
      </p>
      <ol className="mt-3 space-y-1.5">
        {customer.trail.map((step, i) => (
          <li key={i} className="flex gap-2.5 text-[12.5px] text-ink-soft">
            <span className="font-display text-faint">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {blockedReason && (
        <p className="mt-3 border-t border-rule pt-3 text-[12.5px] text-hold">
          Merge held — {blockedReason}
        </p>
      )}
    </section>
  );
}
