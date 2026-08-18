"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { CustomerInfo, QueueItem, TicketFiler } from "@/lib/types";
import { authorName, headline } from "@/lib/display";
import { useSummary } from "@/lib/summary-store";
import { TicketMarkdown } from "./ticket-markdown";
import { BossUpdate } from "./boss-update";
import LoadingState from "./loading-state";

/*
  This surface is a direct build of the Paper file "Merge Queue" - artboards
  "Merge Queue — Inbox" and "PR detail — opened". Spacing, radii, type sizes,
  and the icon paths are taken from that file rather than approximated.
*/

type Status = "ready" | "running" | "waiting" | "failing" | "merged";
type Filter = "ready" | "waiting" | "all";

function statusOf(item: QueueItem, merged: boolean): Status {
  if (merged) return "merged";
  if (item.gate.ciState === "failing") return "failing";
  if (item.gate.ciState === "pending") return "running";
  if (item.gate.unresolvedBotReviews > 0) return "waiting";
  return "ready";
}


const TITLES: Record<Filter, string> = {
  ready: "Ready to merge",
  waiting: "Waiting on checks or review",
  all: "All open",
};

/*
  How often the queue re-polls GitHub/Linear on its own. The boss keeps this
  open in the background while coding, so we never fully stop - we just back
  off when the tab is hidden (nobody's reading it that second) and run the
  tighter cadence while it's in focus. Three minutes leaves enough GitHub
  budget for two open tabs plus the ten-minute Slack publisher at the 50-PR
  ceiling. After the first full fill, polls use the gates-only path so Linear
  and customer lookups are not repeated every tick.
*/
const POLL_VISIBLE_MS = 3 * 60_000;
const POLL_HIDDEN_MS = 10 * 60_000;

/*
  How long the detail view holds on "Merged" before it returns to the board.
  Long enough to register the confirmation, short enough that it still feels
  like one action - and it lands before the row's 700ms exit hold begins.
*/
const MERGE_RETURN_MS = 900;

type RefreshKind = "full" | "gates" | "vision";

export function Rundown({
  items: initialItems,
  mock,
  missingRepos: initialMissing = [],
}: {
  items: QueueItem[];
  mock: boolean;
  missingRepos?: string[];
}) {
  const [items, setItems] = useState(initialItems);
  const [missingRepos, setMissingRepos] = useState(initialMissing);
  const [mergedIds, setMergedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("ready");
  const [author, setAuthor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  /*
    First paint receives only the newest rows. This request fills in the rest
    without replacing the route or hiding those rows behind a loading shell.
    The same path powers manual refresh and polling, so subsequent updates also
    preserve the current filter, author, and open detail.
  */
  const [pending, setPending] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const filledRef = useRef(false);

  // Until the first background fetch lands, the list is only the newest rows
  // the server rendered - so the page has to say more are still coming.
  const [filled, setFilled] = useState(false);

  const refresh = useCallback(async (kind: RefreshKind = "full") => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const params = new URLSearchParams();
      if (kind === "gates") params.set("mode", "gates");
      if (kind === "vision") params.set("vision", "1");
      const query = params.toString();
      const response = await fetch(
        query ? `/api/queue?${query}` : "/api/queue",
        { cache: "no-store" },
      );
      if (!response.ok) {
        setRefreshError(
          response.status === 401
            ? "Session expired — sign in again to refresh the queue."
            : "Could not refresh the queue. Showing the last good load.",
        );
        return;
      }
      const data = (await response.json()) as {
        items?: QueueItem[];
        missingRepos?: string[];
      };
      if (Array.isArray(data.items)) {
        setItems(data.items);
        setMissingRepos(data.missingRepos ?? []);
        setRefreshedAt(Date.now());
        setFilled(true);
        filledRef.current = true;
        setRefreshError(null);
      }
    } catch {
      // Keep the already-rendered newest rows. The next poll or a manual
      // refresh can fill the queue when the network recovers.
      setRefreshError(
        "Could not reach the queue service. Showing the last good load.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);

  const refreshFull = useCallback(() => void refresh("full"), [refresh]);
  const refreshVision = useCallback(() => void refresh("vision"), [refresh]);

  /*
    Auto-poll so the board stays current with no clicks. We hold `pending` in a
    ref and read it inside the tick so a slow refresh never gets a second one
    stacked on top. The tab is usually in the background while the boss codes,
    so we keep polling there too - just at POLL_HIDDEN_MS instead of the tighter
    POLL_VISIBLE_MS - and fire once immediately when he flips back so he never
    lands on a stale board.
  */
  useEffect(() => {
    let id: ReturnType<typeof setInterval>;

    const tick = () => {
      if (pendingRef.current) return;
      // First fill needs full enrichment; later ticks only refresh CI/bots.
      void refresh(filledRef.current ? "gates" : "full");
    };

    const arm = () => {
      clearInterval(id);
      const ms =
        document.visibilityState === "visible"
          ? POLL_VISIBLE_MS
          : POLL_HIDDEN_MS;
      id = setInterval(tick, ms);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
      arm();
    };

    // Fill the remainder of the queue immediately after the newest rows
    // hydrate, then settle into the normal polling cadence.
    tick();
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  /*
    A row that finished its exit animation is gone from the board immediately,
    rather than lingering at half opacity until a poll notices the pull request
    closed. Tracked separately from `mergedIds` so the row can stay mounted for
    the length of the animation before it is dropped.
  */
  const [goneIds, setGoneIds] = useState<Set<string>>(new Set());

  // Everything that counts rows - the rail, the author tabs, the sections -
  // reads from here, so a row that slid away leaves every tally at once.
  const liveItems = useMemo(
    () => items.filter((item) => !goneIds.has(item.id)),
    [items, goneIds],
  );

  const decorated = useMemo(
    () =>
      liveItems.map((item) => ({
        item,
        status: statusOf(item, mergedIds.has(item.id)),
      })),
    [liveItems, mergedIds],
  );

  const scoped = useMemo(
    () => (author ? decorated.filter((d) => d.item.author === author) : decorated),
    [decorated, author],
  );

  const ready = scoped.filter((d) => d.status === "ready" || d.status === "merged");
  const held = scoped.filter(
    (d) =>
      d.status === "waiting" ||
      d.status === "failing" ||
      d.status === "running",
  );

  const counts = {
    ready: scoped.filter((d) => d.status === "ready").length,
    waiting: held.length,
    all: scoped.length,
  };

  const authors = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of liveItems)
      map.set(item.author, (map.get(item.author) ?? 0) + 1);
    return [...map.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [liveItems]);

  const opened = decorated.find((d) => d.item.id === openId);

  function markMerged(id: string) {
    setMergedIds((prev) => new Set(prev).add(id));
  }

  function dropRow(id: string) {
    setGoneIds((prev) => new Set(prev).add(id));
  }

  // Stable so the detail view's return timer survives a poll re-render.
  const closeDetail = useCallback(() => setOpenId(null), []);

  if (opened) {
    return (
      <Detail
        item={opened.item}
        status={opened.status}
        onBack={closeDetail}
        onMerged={() => markMerged(opened.item.id)}
      />
    );
  }

  const showReady = filter === "ready" || filter === "all";
  const showHeld = filter === "waiting" || filter === "all" || filter === "ready";

  return (
    <div className="flex min-h-screen bg-bg">
      <Rail
        counts={counts}
        filter={filter}
        onFilter={setFilter}
        items={liveItems}
      />

      <main className="flex min-w-0 grow flex-col gap-[22px] pb-[32px] pl-[28px] pr-[32px] pt-[28px]">
        <Header
          title={TITLES[filter]}
          mock={mock}
          refreshedAt={refreshedAt}
          pending={pending}
          onRefresh={refreshFull}
        />

        <AuthorTabs
          authors={authors}
          total={liveItems.length}
          value={author}
          onChange={setAuthor}
        />

        {refreshError && (
          <p className="rounded-lg bg-warn-wash px-[14px] py-[10px] text-[13px] leading-[20px] text-warn">
            {refreshError}
          </p>
        )}

        {missingRepos.length > 0 && (
          <p className="rounded-lg bg-warn-wash px-[14px] py-[10px] text-[13px] leading-[20px] text-warn">
            GitHub did not answer for{" "}
            {missingRepos.map((r) => r.split("/").at(-1)).join(", ")} - those
            pull requests are missing from this list. The next refresh retries.
          </p>
        )}

        {showReady && (
          <div className="flex flex-col gap-[6px]">
            {ready.length === 0 ? (
              <Empty>Nothing is cleared to merge right now.</Empty>
            ) : (
              ready.map(({ item, status }) => (
                <LeavingRow
                  key={item.id}
                  merged={status === "merged"}
                  onGone={() => dropRow(item.id)}
                >
                  <Row
                    item={item}
                    status={status}
                    onOpen={() => setOpenId(item.id)}
                    onMerged={() => markMerged(item.id)}
                    onSearchAgain={refreshVision}
                  />
                </LeavingRow>
              ))
            )}
          </div>
        )}

        {showHeld && held.length > 0 && (
          <div className="flex flex-col gap-[6px] pt-[12px]">
            {filter !== "waiting" && (
              <div className="flex items-baseline gap-[9px] px-[2px] pb-[8px]">
                <h2 className="text-[16px] font-semibold leading-[22px] tracking-[-0.01em] text-text">
                  Waiting on checks or review
                </h2>
                <span className="tnum text-[14px] leading-[20px] text-text-faint">
                  {held.length}
                </span>
              </div>
            )}
            {held.map(({ item, status }) => (
              <LeavingRow
                key={item.id}
                merged={status === "merged"}
                onGone={() => dropRow(item.id)}
              >
                <Row
                  item={item}
                  status={status}
                  onOpen={() => setOpenId(item.id)}
                  onMerged={() => markMerged(item.id)}
                  onSearchAgain={refreshVision}
                />
              </LeavingRow>
            ))}
          </div>
        )}

        {filter === "waiting" && held.length === 0 && (
          <Empty>Nothing is waiting on checks or review.</Empty>
        )}

        {!filled && (
          <div className="flex justify-center pt-[10px]">
            <LoadingState label="Polling more" />
          </div>
        )}
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------- header */

function Header({
  title,
  mock,
  refreshedAt,
  pending,
  onRefresh,
}: {
  title: string;
  mock: boolean;
  refreshedAt: number | null;
  pending: boolean;
  onRefresh: () => void;
}) {
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const label = (() => {
    if (pending && refreshedAt === null) return "Loading the rest of the queue…";
    if (pending) return "Checking GitHub and Linear…";
    if (refreshedAt === null) return "Updated just now";
    const mins = Math.floor((Date.now() - refreshedAt) / 60_000);
    if (mins < 1) return "Updated just now";
    if (mins === 1) return "Updated 1 minute ago";
    return `Updated ${mins} minutes ago`;
  })();

  return (
    <div className="flex items-center justify-between gap-[24px]">
      <div className="flex min-w-0 items-center gap-[10px]">
        <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-text">
          {title}
        </h1>
        {mock && (
          <span className="rounded-full bg-control px-[10px] py-[3px] text-[12px] text-text-2">
            Sample data
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-[14px] pt-[5px]">
        <span
          aria-live="polite"
          className="text-[13px] leading-[20px] text-text-faint"
        >
          {label}
        </span>
        <button
          onClick={onRefresh}
          disabled={pending}
          title="Re-check now (also auto-refreshes every 3 minutes)"
          className={
            "flex h-[34px] items-center gap-[7px] rounded-full bg-control px-[15px] transition " +
            (pending
              ? "opacity-60"
              : "hover:bg-control-hi active:scale-[0.97]")
          }
        >
          <span className={pending ? "flex animate-spin" : "flex"}>
            <IconRefresh />
          </span>
          <span className="text-[14px] font-medium leading-[20px] text-text">
            {pending ? "Refreshing" : "Refresh"}
          </span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- rail */

function Rail({
  counts,
  filter,
  onFilter,
  items,
}: {
  counts: { ready: number; waiting: number; all: number };
  filter: Filter;
  onFilter: (f: Filter) => void;
  items: QueueItem[];
}) {
  const nav: { id: Filter; label: string; count: number; icon: React.ReactNode }[] =
    [
      { id: "ready", label: "Ready to merge", count: counts.ready, icon: <IconTray /> },
      { id: "waiting", label: "Waiting", count: counts.waiting, icon: <IconClock /> },
      { id: "all", label: "All open", count: counts.all, icon: <IconList /> },
    ];

  const repos = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      const name = item.repo.split("/")[1] ?? item.repo;
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return [...map.entries()];
  }, [items]);

  const REPO_DOT = ["bg-accent", "bg-[#7C8AF0]", "bg-pass", "bg-warn"];

  return (
    <aside className="hidden w-[220px] shrink-0 flex-col gap-[20px] self-stretch bg-surface-2 px-[12px] pb-[16px] pt-[20px] md:flex">
      <div className="flex items-center gap-[9px] px-[8px] pb-[4px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/slashy.png"
          alt="Slashy"
          width={22}
          height={22}
          className="rounded-[6px]"
        />
        <span className="text-[14px] font-semibold leading-[18px] tracking-[-0.01em] text-text">
          Merge control
        </span>
      </div>

      <div className="flex flex-col gap-[2px]">
        {nav.map((n) => {
          const active = filter === n.id;
          return (
            <button
              key={n.id}
              onClick={() => onFilter(n.id)}
              aria-current={active ? "true" : undefined}
              className={
                "flex items-center gap-[10px] rounded-lg px-[8px] py-[7px] transition " +
                (active ? "bg-control" : "hover:bg-control")
              }
            >
              <span className={active ? "text-text" : "text-text-2"}>
                {n.icon}
              </span>
              <span
                className={
                  "grow text-left text-[14px] font-medium leading-[20px] " +
                  (active ? "text-text" : "text-text-2")
                }
              >
                {n.label}
              </span>
              <span className="tnum text-[13px] leading-[16px] text-text-2">
                {n.count}
              </span>
            </button>
          );
        })}
      </div>

      {repos.length > 0 && (
        <div className="flex flex-col gap-[2px]">
          <div className="px-[8px] pb-[6px] pt-[4px]">
            <span className="text-[13px] leading-[16px] text-text-faint">
              Repos
            </span>
          </div>
          {repos.map(([name, count], i) => (
            <div
              key={name}
              className="flex items-center gap-[10px] rounded-lg px-[8px] py-[7px]"
            >
              <span className="flex w-[16px] shrink-0 justify-center">
                <span
                  className={
                    "h-[7px] w-[7px] shrink-0 rounded-full " +
                    (REPO_DOT[i % REPO_DOT.length] ?? "bg-accent")
                  }
                />
              </span>
              <span className="grow truncate text-[14px] leading-[20px] text-text-2">
                {name}
              </span>
              <span className="tnum text-[13px] leading-[16px] text-text-2">
                {count}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------ author tabs */

function AuthorTabs({
  authors,
  total,
  value,
  onChange,
}: {
  authors: [string, number][];
  total: number;
  value: string | null;
  onChange: (a: string | null) => void;
}) {
  if (authors.length < 2) return null;

  const tabs: [string | null, string, number][] = [
    [null, "Everyone", total],
    ...authors.map(
      ([login, count]) =>
        [login, authorName(login), count] as [string, string, number],
    ),
  ];

  return (
    <div className="flex max-w-full items-center gap-[2px] self-start overflow-x-auto rounded-lg bg-control p-[2px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map(([id, label, count]) => {
        const active = value === id;
        return (
          <button
            key={id ?? "everyone"}
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={
              "flex h-[28px] shrink-0 items-center gap-[6px] rounded-md px-[12px] transition " +
              (active ? "bg-bg shadow-[0_1px_2px_#0000000D]" : "hover:bg-control")
            }
          >
            <span
              className={
                "max-w-[10rem] truncate text-[14px] font-medium leading-[20px] " +
                (active ? "text-text" : "text-text-2")
              }
            >
              {label}
            </span>
            <span
              className={
                "tnum text-[13px] leading-[20px] " +
                (active ? "text-text-2" : "text-text-faint")
              }
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- row */

/**
 * Holds a merged row still for a beat so it reads as "Merged", plays the
 * slide-out, then tells the board to drop it.
 *
 * The animation name is checked because `cut-in` on the row itself also raises
 * an animation event from inside this subtree, and reacting to that one would
 * delete the row the moment it appeared.
 */
function LeavingRow({
  merged,
  onGone,
  children,
}: {
  merged: boolean;
  onGone: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={merged ? "row-slide-out" : undefined}
      onAnimationEnd={(event) => {
        if (event.animationName === "row-slide-out") onGone();
      }}
    >
      {children}
    </div>
  );
}

/**
 * The boss update, inline on the row. Only fetched for rows that are clear to
 * merge (and in the detail view) so a long waiting list does not fire dozens
 * of Anthropic calls on first paint. Failures stay silent here - the row still
 * merges, and the detail view is where the reason belongs.
 */
function RowUpdate({
  item,
  enabled,
}: {
  item: QueueItem;
  enabled: boolean;
}) {
  const { text, loading } = useSummary(item, { enabled });

  if (!enabled) return null;
  if (loading) {
    return (
      <span className="mt-[3px] flex h-[13px] w-full max-w-[420px] items-center">
        <span className="h-[7px] w-full animate-pulse rounded-full bg-rule-strong" />
      </span>
    );
  }
  if (!text) return null;

  return (
    <span className="line-clamp-2 text-[13px] leading-[19px] text-text-faint">
      {text}
    </span>
  );
}

const Row = memo(function Row({
  item,
  status,
  onOpen,
  onMerged,
  onSearchAgain,
}: {
  item: QueueItem;
  status: Status;
  onOpen: () => void;
  onMerged: () => void;
  onSearchAgain: () => void;
}) {
  const [state, setState] = useState<"idle" | "merging" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const merged = status === "merged";
  const quiet = status === "waiting" || status === "failing";
  const wantUpdate = status === "ready";

  async function merge() {
    setState("merging");
    setError(null);
    try {
      const res = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: item.repo, number: item.number }),
      });
      const data = await res.json();
      if (res.ok && data.merged) {
        onMerged();
        setState("idle");
      } else {
        setState("error");
        setError(data.message ?? "The merge did not go through.");
      }
    } catch {
      setState("error");
      setError("Could not reach GitHub. Nothing was merged.");
    }
  }

  return (
    <div
      className={
        "cut-in group flex flex-col gap-[10px] rounded-xl px-[16px] py-[14px] transition-colors duration-150 md:flex-row md:items-center md:gap-[14px] " +
        (quiet ? "bg-quiet hover:bg-control" : "bg-surface-2 hover:bg-rule") +
        (merged ? " opacity-50" : "")
      }
    >
      <button
        onClick={onOpen}
        title="Open the full ticket"
        className="flex min-w-0 grow flex-col gap-[3px] rounded-md text-left"
      >
        <span className="flex min-w-0 items-center gap-[8px]">
          {item.customer.name ? (
            <>
              <span className="shrink-0 text-[14px] font-medium leading-[20px] text-text">
                {item.customer.name}
              </span>
              {item.customer.email ? (
                <span className="line-clamp-1 text-[13px] leading-[20px] text-text-2">
                  {item.customer.email}
                </span>
              ) : item.customer.phone ? (
                <span className="line-clamp-1 text-[13px] leading-[20px] text-text-2">
                  {item.customer.phone}
                </span>
              ) : null}
            </>
          ) : item.customer.email ? (
            // Email but no name: the address carries the identity on its own.
            <span className="line-clamp-1 text-[14px] font-medium leading-[20px] text-text">
              {item.customer.email}
            </span>
          ) : item.customer.phone ? (
            <span className="line-clamp-1 text-[14px] font-medium leading-[20px] text-text">
              {item.customer.phone}
            </span>
          ) : (
            <>
              <span className="shrink-0 text-[14px] font-medium leading-[20px] text-text-2">
                No customer found
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onSearchAgain();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onSearchAgain();
                  }
                }}
                className="shrink-0 text-[13px] leading-[20px] text-accent transition hover:underline"
              >
                Search again
              </span>
            </>
          )}
        </span>
        <span className="line-clamp-1 text-[14px] leading-[20px] text-text-2 transition-colors group-hover:text-text">
          {headline(item)}
        </span>
        <RowUpdate item={item} enabled={wantUpdate} />
      </button>

      <div className="flex shrink-0 items-center justify-between gap-[14px] md:justify-end">
        <div className="flex shrink-0 items-center gap-[6px] md:w-[190px] md:justify-end">
          <StatusCell item={item} status={status} error={error} />
        </div>

        <div className="flex items-center gap-[8px]">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="flex h-[32px] items-center justify-center rounded-full bg-control px-[15px] text-[14px] font-medium leading-[20px] text-text transition hover:bg-control-hi active:scale-[0.97]"
          >
            View PR
          </a>
          <button
            onClick={merge}
            disabled={!item.mergeable || merged || state === "merging"}
            title={item.blockedReason ?? "Squash merge"}
            className={
              "flex h-[32px] items-center justify-center rounded-full px-[18px] text-[14px] font-medium leading-[20px] transition " +
              (merged
                ? "text-text-faint"
                : item.mergeable
                  ? "bg-accent text-white hover:bg-[#3A92E8] active:scale-[0.97]"
                  : "text-text-faint hover:bg-control")
            }
          >
            {state === "merging" ? "Merging…" : merged ? "Merged" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}, (prev, next) => {
  return (
    prev.status === next.status &&
    prev.item.id === next.item.id &&
    prev.item.updatedAt === next.item.updatedAt &&
    prev.item.mergeable === next.item.mergeable &&
    prev.item.blockedReason === next.item.blockedReason &&
    prev.item.problem === next.item.problem &&
    prev.item.customer.email === next.item.customer.email &&
    prev.item.customer.name === next.item.customer.name &&
    prev.item.customer.phone === next.item.customer.phone &&
    prev.item.gate.ciState === next.item.gate.ciState &&
    prev.item.gate.unresolvedBotReviews === next.item.gate.unresolvedBotReviews
  );
});

function StatusCell({
  item,
  status,
  error,
}: {
  item: QueueItem;
  status: Status;
  error: string | null;
}) {
  if (error) {
    return (
      <>
        <IconAlert />
        <span className="line-clamp-1 text-[13px] leading-[20px] text-fail">
          {error}
        </span>
      </>
    );
  }
  if (status === "merged") {
    return (
      <>
        <IconCheck stroke="var(--color-text-faint)" />
        <span className="text-[13px] leading-[20px] text-text-faint">
          Merged
        </span>
      </>
    );
  }
  if (status === "failing") {
    return (
      <>
        <IconAlert />
        <span className="text-[13px] leading-[20px] text-fail">
          Checks failing
        </span>
      </>
    );
  }
  if (status === "running") {
    return (
      <>
        <span className="text-text-faint">
          <IconClock />
        </span>
        <span className="text-[13px] leading-[20px] text-text-2">
          Checks running
        </span>
      </>
    );
  }
  if (status === "waiting") {
    const n = item.gate.unresolvedBotReviews;
    return (
      <>
        <IconBubble />
        <span className="text-[13px] leading-[20px] text-warn">
          {n} review comment{n === 1 ? "" : "s"} open
        </span>
      </>
    );
  }
  return (
    <>
      <IconCheck />
      <span className="text-[13px] leading-[20px] text-text-2">
        Checks passed
      </span>
    </>
  );
}

/* ----------------------------------------------------------------- detail */

function Detail({
  item,
  status,
  onBack,
  onMerged,
}: {
  item: QueueItem;
  status: Status;
  onBack: () => void;
  onMerged: () => void;
}) {
  const [state, setState] = useState<"idle" | "merging" | "merged" | "error">(
    status === "merged" ? "merged" : "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const repoName = item.repo.split("/")[1] ?? item.repo;
  const merged = state === "merged" || status === "merged";

  /*
    Merging is the last thing anyone does on this page, so the view returns to
    the board by itself rather than leaving a dead "Merged" button on screen.
    The pause is long enough to read the confirmation; back on the list the row
    is already marked merged, so it picks up its slide-out from there.

    Only a merge performed here schedules the return - arriving at a row that
    was already merged must not bounce the reader straight back out.
  */
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    if (!returning) return;
    const id = setTimeout(onBack, MERGE_RETURN_MS);
    return () => clearTimeout(id);
  }, [returning, onBack]);

  async function merge() {
    setState("merging");
    setMessage(null);
    try {
      const res = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: item.repo, number: item.number }),
      });
      const data = await res.json();
      if (res.ok && data.merged) {
        setState("merged");
        setMessage(data.message ?? null);
        onMerged();
        setReturning(true);
      } else {
        setState("error");
        setMessage(data.message ?? "The merge did not go through.");
      }
    } catch {
      setState("error");
      setMessage("Could not reach GitHub. Nothing was merged.");
    }
  }

  /*
    A mergeable PR gets no status label: the live Merge button two elements
    away already says it, and a second accent-coloured object in the same bar
    only competes with the one thing that is actually clickable. Status is
    worth the space when it is the exception - and then it speaks in the same
    icon-and-text vocabulary the queue rows use.
  */
  const showStatus = merged || !item.mergeable;

  return (
    <div className="cut-in mx-auto flex min-h-screen w-full max-w-[860px] flex-col bg-bg">
      {/* Tickets run long; the take stays reachable at every scroll depth. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-[20px] bg-bg/90 px-[24px] py-[16px] backdrop-blur">
        <div className="flex items-center gap-[12px]">
          <button
            onClick={onBack}
            aria-label="Back to the queue"
            title="Back to the queue"
            className="rounded-lg p-[4px] text-text-2 transition hover:bg-control hover:text-text active:scale-[0.94]"
          >
            <IconBack />
          </button>
          {showStatus && (
            <span className="flex items-center gap-[7px]">
              <StatusCell
                item={item}
                status={merged ? "merged" : status}
                error={null}
              />
            </span>
          )}
        </div>

        <div className="flex items-center gap-[10px]">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="flex h-[34px] items-center justify-center rounded-full bg-control px-[16px] text-[14px] font-medium leading-[20px] text-text-2 transition hover:bg-control-hi hover:text-text active:scale-[0.97]"
          >
            View on GitHub
          </a>
          <button
            onClick={merge}
            disabled={!item.mergeable || merged || state === "merging"}
            title={item.blockedReason ?? "Squash merge"}
            className={
              "flex h-[34px] items-center justify-center rounded-full px-[22px] text-[14px] font-medium leading-[20px] transition " +
              (merged
                ? "bg-control text-text-2"
                : item.mergeable
                  ? "bg-accent text-white hover:bg-[#3A92E8] active:scale-[0.97]"
                  : "bg-control text-text-faint")
            }
          >
            {state === "merging" ? "Merging…" : merged ? "Merged" : "Merge"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-[20px] px-[24px] pb-[28px] pt-[8px]">
        <div className="flex flex-col gap-[8px]">
          <h1 className="text-[24px] font-semibold leading-[31px] tracking-[-0.02em] text-text">
            {headline(item)}
          </h1>
          <nav
            aria-label="Pull request context"
            className="flex flex-wrap items-stretch gap-[8px]"
          >
            <ContextChip
              label="Repository"
              value={repoName}
              href={`https://github.com/${item.repo}`}
            />
            <ContextChip
              label="Pull request"
              value={`#${item.number}`}
              href={item.url}
              mono
            />
            {item.ticket && (
              <ContextChip
                label="Ticket"
                value={item.ticket.id}
                href={item.ticket.url}
                mono
                accent
              />
            )}
          </nav>
        </div>

        <CustomerCard customer={item.customer} filedBy={item.ticket?.filedBy ?? null} />

        <BossUpdate item={item} />

        <section className="flex flex-col gap-[12px] pt-[6px]">
          <h2 className="text-[16px] font-semibold leading-[22px] tracking-[-0.01em] text-text">
            What the customer reported
          </h2>
          <TicketMarkdown body={item.ticket?.description ?? item.problem} />
        </section>

        <Gates item={item} />

        {message && (
          <p
            className={
              "text-[13px] leading-[20px] " +
              (state === "error" ? "text-fail" : "text-pass")
            }
          >
            {message}
          </p>
        )}
        {!message && item.blockedReason && !merged && (
          <p className="text-[13px] leading-[20px] text-warn">
            {item.blockedReason}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One fact about the PR - repo, number, ticket. Stacked label over value on a
 * raised chip: the previous inline treatment sat at faint-grey on the page
 * background and read as decoration rather than the identifiers being looked
 * for.
 */
function ContextChip({
  label,
  value,
  href,
  mono,
  accent,
}: {
  label: string;
  value: string;
  href?: string | null;
  mono?: boolean;
  accent?: boolean;
}) {
  const body = (
    <>
      <span className="text-[12px] leading-[16px] text-text-2">{label}</span>
      <span
        className={
          "text-[15px] font-semibold leading-[20px] " +
          (mono ? "font-mono " : "") +
          (accent ? "text-accent" : "text-text")
        }
      >
        {value}
      </span>
    </>
  );

  const shell =
    "flex flex-col gap-[1px] rounded-lg bg-surface-2 px-[12px] py-[7px]";

  if (!href) return <span className={shell}>{body}</span>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`${shell} transition hover:bg-control`}
    >
      {body}
    </a>
  );
}

function CustomerCard({
  customer,
  filedBy,
}: {
  customer: CustomerInfo;
  filedBy: TicketFiler | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!customer.email) return;
    await navigator.clipboard.writeText(customer.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  // No customer resolved: fall back to whoever filed the ticket, so the PR
  // still has a face to ask about it rather than a dead end. A phone read from
  // a screenshot counts as a resolved contact, so it never falls through here.
  if (!customer.name && !customer.email && !customer.phone) {
    if (filedBy && (filedBy.name || filedBy.email)) {
      return <FiledByCard filedBy={filedBy} />;
    }
    return (
      <div className="flex items-center gap-[14px] rounded-xl bg-surface-2 p-[16px]">
        <p className="text-[14px] leading-[20px] text-text-2">
          No customer is linked to this pull request. It can still be merged.
        </p>
      </div>
    );
  }

  // Ambiguous: several addresses matched and none is trusted enough to pick.
  // List every one as a live mailto instead of a dead "needs a pick" count, so
  // the boss can just reach out to whichever fits.
  if (!customer.email && customer.candidates.length > 0) {
    return (
      <div className="flex flex-col gap-[12px] rounded-xl bg-surface-2 p-[16px]">
        <div className="flex min-w-0 flex-col gap-[2px]">
          {customer.name && (
            <span className="text-[15px] font-medium leading-[21px] text-text">
              {customer.name}
            </span>
          )}
          {customer.phone && (
            <a
              href={`tel:${customer.phone.replace(/\s+/g, "")}`}
              className="text-[13px] leading-[18px] text-text-2 transition hover:text-text"
            >
              {customer.phone}
            </a>
          )}
          <span className="text-[13px] leading-[18px] text-text-2">
            {customer.candidates.length} possible addresses - reach out to
            whichever fits
          </span>
        </div>
        <ul className="flex flex-col gap-[6px]">
          {customer.candidates.map((c) => (
            <li key={c.email}>
              <a
                href={`mailto:${c.email}`}
                className="flex items-center justify-between gap-[10px] rounded-lg bg-surface px-[12px] py-[8px] transition hover:bg-control-hi"
              >
                <span className="truncate text-[14px] leading-[20px] text-text">
                  {c.email}
                </span>
                {c.note && (
                  <span className="shrink-0 text-[12px] leading-[16px] text-text-faint">
                    {c.note}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-[14px] rounded-xl bg-surface-2 p-[16px]">
      <div className="flex min-w-0 grow flex-col gap-[3px]">
        {customer.name && (
          <div className="flex items-center gap-[8px]">
            <span className="text-[15px] font-medium leading-[21px] text-text">
              {customer.name}
            </span>
          </div>
        )}
        {customer.email && (
          <a
            href={`mailto:${customer.email}`}
            className={
              "truncate transition hover:text-text " +
              (customer.name
                ? "text-[14px] leading-[20px] text-text-2"
                : "text-[15px] font-medium leading-[21px] text-text")
            }
          >
            {customer.email}
          </a>
        )}
        {customer.phone && (
          <a
            href={`tel:${customer.phone.replace(/\s+/g, "")}`}
            className={
              "truncate transition hover:text-text " +
              (customer.name || customer.email
                ? "text-[14px] leading-[20px] text-text-2"
                : "text-[15px] font-medium leading-[21px] text-text")
            }
          >
            {customer.phone}
          </a>
        )}
        {!customer.email && !customer.phone && (
          <span className="text-[14px] leading-[20px] text-warn">
            No email address found
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-[10px]">
        {(customer.email || customer.phone) && customer.trail.length > 0 && (
          <span className="hidden text-[13px] leading-[20px] text-text-2 lg:inline">
            {customer.phone && !customer.email
              ? "Phone only - from screenshot"
              : customer.trail.at(-1)}
          </span>
        )}
        {customer.email && (
          <button
            onClick={copy}
            className="flex h-[32px] items-center justify-center rounded-full bg-control px-[16px] text-[14px] font-medium leading-[20px] text-text transition hover:bg-control-hi"
          >
            {copied ? "Copied" : "Copy email"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when no customer resolves. The teammate who opened the ticket takes the
 * card, marked plainly as the filer so it is never read as a customer contact.
 */
function FiledByCard({ filedBy }: { filedBy: TicketFiler }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!filedBy.email) return;
    await navigator.clipboard.writeText(filedBy.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="flex items-center gap-[14px] rounded-xl bg-surface-2 p-[16px]">
      <div className="flex min-w-0 grow flex-col gap-[3px]">
        {filedBy.name && (
          <span className="text-[15px] font-medium leading-[21px] text-text">
            {filedBy.name}
          </span>
        )}
        {filedBy.email ? (
          <a
            href={`mailto:${filedBy.email}`}
            className={
              "truncate transition hover:text-text " +
              (filedBy.name
                ? "text-[14px] leading-[20px] text-text-2"
                : "text-[15px] font-medium leading-[21px] text-text")
            }
          >
            {filedBy.email}
          </a>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-[10px]">
        <span className="hidden text-[13px] leading-[20px] text-text-faint lg:inline">
          Filed the ticket · no customer linked
        </span>
        {filedBy.email && (
          <button
            onClick={copy}
            className="flex h-[32px] items-center justify-center rounded-full bg-control px-[16px] text-[14px] font-medium leading-[20px] text-text transition hover:bg-control-hi"
          >
            {copied ? "Copied" : "Copy email"}
          </button>
        )}
      </div>
    </div>
  );
}

function Gates({ item }: { item: QueueItem }) {
  const gates = [
    {
      ok: item.gate.ciGreen,
      pending: item.gate.ciState === "pending",
      label:
        item.gate.ciState === "passing"
          ? "Every required check passed"
          : item.gate.ciState === "pending"
            ? "Checks are still running"
            : "Required checks are failing",
      note:
        item.gate.ciState === "passing"
          ? "All passing"
          : item.gate.ciState === "pending"
            ? "In progress"
            : "Not passing",
    },
    {
      ok: item.gate.unresolvedBotReviews === 0,
      label:
        item.gate.unresolvedBotReviews === 0
          ? "No review comments left open"
          : "Review comments still open",
      note:
        item.gate.unresolvedBotReviews === 0
          ? "All resolved"
          : `${item.gate.unresolvedBotReviews} open`,
    },
    { ok: true, label: "Merge method", note: "Squash merge" },
  ];

  return (
    <section className="mt-[6px] flex flex-col gap-[14px] rounded-xl bg-surface-2 px-[20px] py-[18px]">
      <h2 className="text-[14px] font-semibold leading-[20px] text-text">
        Before it merges
      </h2>
      {gates.map((g) => (
        <div key={g.label} className="flex items-center gap-[11px]">
          {g.ok ? (
            <IconCheck size={16} />
          ) : "pending" in g && g.pending ? (
            <span className="text-text-faint">
              <IconClock />
            </span>
          ) : (
            <IconAlert size={16} />
          )}
          <span className="grow text-[14px] leading-[20px] text-text">
            {g.label}
          </span>
          <span
            className={
              "shrink-0 text-[13px] leading-[20px] " +
              (g.ok || ("pending" in g && g.pending) ? "text-text-2" : "text-fail")
            }
          >
            {g.note}
          </span>
        </div>
      ))}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl bg-quiet px-[16px] py-[24px] text-center text-[14px] leading-[20px] text-text-faint">
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ icons */
/* Paths taken verbatim from the Paper file so the build matches the design. */

function IconTray() {
  return (
    <svg width="18.36" height="13.23" viewBox="0 0 136 98" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M27.371 89.817L107.999 89.817C118.145 89.817 123.370 84.583 123.370 74.578L123.370 46.889C123.370 41.762 122.767 39.391 120.298 36.401L104.235 16.851C98.699 10.143 95.822 8.000 87.871 8.000L47.499 8.000C39.588 8.000 36.660 10.153 31.115 16.871L15.121 36.401C12.643 39.391 12 41.762 12 46.889L12 74.578C12 84.592 17.266 89.817 27.371 89.817ZM23.451 43.080C21.935 43.080 21.604 41.766 22.401 40.748L39.453 19.509C41.580 16.844 43.949 15.718 47.138 15.718L88.231 15.718C91.420 15.718 93.831 16.844 95.957 19.509L113.018 40.748C113.775 41.766 113.452 43.080 111.968 43.080L81.553 43.080C79.117 43.080 77.977 44.829 77.977 46.681L77.977 46.836C77.977 51.934 74.041 57.380 67.705 57.380C61.370 57.380 57.393 51.934 57.393 46.836L57.393 46.681C57.393 44.829 56.293 43.080 53.825 43.080ZM27.806 80.601C23.445 80.601 21.056 78.334 21.056 73.810L21.056 51.209L49.458 51.209C50.942 59.602 58.237 65.788 67.705 65.788C77.174 65.788 84.427 59.543 85.911 51.209L114.313 51.209L114.313 73.810C114.313 78.334 111.889 80.601 107.564 80.601Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="15.26" height="15.26" viewBox="0 0 113 113" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M56.392 104.784C83.133 104.784 104.834 83.133 104.834 56.392C104.834 29.652 83.133 8.000 56.392 8.000C29.701 8.000 8 29.652 8 56.392C8 83.133 29.701 104.784 56.392 104.784ZM56.392 95.272C34.902 95.272 17.544 77.882 17.544 56.392C17.544 34.902 34.902 17.512 56.392 17.512C77.891 17.512 95.281 34.902 95.281 56.392C95.281 77.882 77.891 95.272 56.392 95.272ZM32.698 62.195L56.351 62.195C58.456 62.195 60.088 60.572 60.088 58.499L60.088 27.805C60.088 25.709 58.456 24.086 56.351 24.086C54.313 24.086 52.673 25.709 52.673 27.805L52.673 54.780L32.698 54.780C30.593 54.780 29.011 56.411 29.011 58.499C29.011 60.572 30.593 62.195 32.698 62.195Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconList() {
  return (
    <svg width="16.34" height="9.05" viewBox="0 0 121 67" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M16.180 58.724L103.803 58.724C106.161 58.724 108.033 56.792 108.033 54.445C108.033 52.077 106.171 50.174 103.803 50.174L16.180 50.174C13.863 50.174 12 52.097 12 54.445C12 56.772 13.873 58.724 16.180 58.724ZM16.180 37.628L103.803 37.628C106.161 37.628 108.033 35.695 108.033 33.357C108.033 30.990 106.171 29.078 103.803 29.078L16.180 29.078C13.863 29.078 12 31.009 12 33.357C12 35.676 13.873 37.628 16.180 37.628ZM16.180 16.509L103.803 16.509C106.161 16.509 108.033 14.568 108.033 12.271C108.033 9.903 106.171 8.000 103.803 8.000L16.180 8.000C13.863 8.000 12 9.923 12 12.271C12 14.548 13.873 16.509 16.180 16.509Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="12.5" height="14.75" viewBox="0 0 100 118" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M49.841 109.780C72.967 109.780 91.673 91.024 91.673 67.898C91.673 65.360 89.588 63.325 87.100 63.325C84.594 63.325 82.517 65.360 82.517 67.898C82.517 85.947 67.881 100.533 49.841 100.533C31.792 100.533 17.165 85.947 17.165 67.898C17.165 49.858 31.792 35.222 49.841 35.222C53.723 35.222 57.408 35.868 60.848 37.150C63.660 38.209 67.119 36.518 67.154 32.986C67.172 30.325 65.255 29.049 63.595 28.500C59.373 26.935 54.706 26.107 49.841 26.107C26.715 26.107 8 44.813 8 67.948C8 91.024 26.715 109.780 49.841 109.780ZM61.993 32.182L45.260 48.714C44.413 49.519 43.983 50.609 43.983 51.814C43.983 54.355 45.956 56.337 48.442 56.337C49.814 56.337 50.831 55.854 51.647 55.079L70.886 35.682C71.872 34.687 72.334 33.591 72.334 32.272C72.334 31.054 71.812 29.867 70.886 28.930L51.656 9.369C50.830 8.524 49.790 8.000 48.433 8.000C45.947 8.000 43.983 10.074 43.983 12.634C43.983 13.871 44.404 14.962 45.219 15.767Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconCheck({
  size = 15,
  stroke = "var(--color-pass)",
}: {
  size?: number;
  stroke?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path
        d="M3.4 8.4l3 3 6.2-6.6"
        fill="none"
        stroke={stroke}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBubble() {
  return (
    <svg width="16.13" height="14.38" viewBox="0 0 129 115" aria-hidden style={{ flexShrink: 0 }}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M41.126 106.939C43.083 106.939 44.530 105.990 46.864 103.866L64.027 88.336L94.968 88.336C109.051 88.336 116.981 80.274 116.981 66.372L116.981 30.005C116.981 16.103 109.051 8.000 94.968 8.000L34.013 8.000C19.921 8.000 12 16.085 12 30.005L12 66.372C12 80.291 20.118 88.336 33.717 88.336L36.621 88.336L36.621 101.878C36.621 104.951 38.312 106.939 41.126 106.939Z"
        fill="var(--color-warn)"
      />
    </svg>
  );
}

function IconAlert({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size * 0.905}
      viewBox="7.812 -71.777 80.566 72.9"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path
        fillRule="nonzero"
        d="M18.75 1.123L77.441 1.123C84.228 1.123 88.379-3.613 88.379-9.814C88.379-11.621 87.842-13.525 86.865-15.234L57.471-66.26C55.371-69.873 51.807-71.777 48.096-71.777C44.385-71.777 40.772-69.873 38.721-66.26L9.326-15.234C8.301-13.477 7.813-11.621 7.813-9.814C7.813-3.613 11.963 1.123 18.75 1.123ZM48.096-24.609C45.85-24.609 44.58-25.879 44.531-28.125L43.994-48.926C43.945-51.221 45.654-52.832 48.047-52.832C50.391-52.832 52.197-51.172 52.148-48.877L51.514-28.125C51.465-25.83 50.244-24.609 48.096-24.609ZM48.096-11.377C45.605-11.377 43.408-13.33 43.408-15.82C43.408-18.311 45.557-20.313 48.096-20.313C50.586-20.313 52.734-18.311 52.734-15.82C52.734-13.281 50.586-11.377 48.096-11.377Z"
        fill="var(--color-fail)"
      />
    </svg>
  );
}

function IconBack() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        d="M11 3.6L5.6 9l5.4 5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
