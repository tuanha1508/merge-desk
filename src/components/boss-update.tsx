"use client";

import { useState } from "react";
import { useSummary } from "@/lib/summary-store";
import type { QueueItem } from "@/lib/types";

/**
 * The 2-sentence, non-technical update the CTO forwards as-is. Styled from
 * the "PR detail — opened" artboard in the Paper file.
 *
 * The text comes from the shared store, so a row that already fetched this
 * update on the list renders it here instantly.
 */
export function BossUpdate({ item }: { item: QueueItem }) {
  const { text, error, loading } = useSummary(item);
  const [copied, setCopied] = useState(false);
  const body = text ?? error ?? "";

  async function copy() {
    await navigator.clipboard.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="flex flex-col gap-[12px] rounded-xl bg-accent-wash px-[20px] py-[18px]">
      <div className="flex items-center justify-between gap-[16px]">
        <h2 className="text-[14px] font-semibold leading-[20px] text-text">
          Update for your boss
        </h2>
        {text && (
          <button
            onClick={copy}
            className="flex shrink-0 items-center gap-[6px] transition hover:opacity-80"
          >
            <IconCopy />
            <span className="text-[14px] font-medium leading-[20px] text-accent">
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col gap-[8px]" aria-live="polite">
          <div className="h-[10px] w-full animate-pulse rounded-full bg-rule-strong" />
          <div className="h-[10px] w-4/5 animate-pulse rounded-full bg-rule-strong" />
        </div>
      ) : (
        <p
          className={
            "text-[16px] leading-[26px] " + (error ? "text-warn" : "text-text")
          }
        >
          {body}
        </p>
      )}
    </section>
  );
}

function IconCopy() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden style={{ flexShrink: 0 }}>
      <rect
        x="5.6"
        y="5.6"
        width="7.8"
        height="7.8"
        rx="2"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.3"
      />
      <path
        d="M10.4 3.4a1.8 1.8 0 00-1.8-1.8H4.4a2.8 2.8 0 00-2.8 2.8v4.2a1.8 1.8 0 001.8 1.8"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
