/*
  Streamed instantly while the server resolves the queue. The page is
  force-dynamic and every PR fans out to Linear, GitHub, PostHog and Supabase,
  so without this the browser sits on a blank tab until the slowest call lands.
  The shell mirrors the real chrome (220px rail + main column) so the swap to
  live data doesn't jump.
*/
export default function Loading() {
  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="hidden w-[220px] shrink-0 flex-col gap-[20px] self-stretch bg-surface-2 px-[12px] pb-[16px] pt-[25px] md:flex">
        <div className="flex flex-col gap-[6px]">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[32px] animate-pulse rounded-lg bg-control"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>
        <div className="mt-[8px] flex flex-col gap-[6px]">
          <div className="h-[14px] w-[52px] animate-pulse rounded bg-control" />
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-[24px] animate-pulse rounded-md bg-control"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 grow flex-col gap-[22px] pb-[32px] pl-[28px] pr-[32px] pt-[28px]">
        <div className="flex items-center justify-between gap-[24px]">
          <div className="h-[30px] w-[220px] animate-pulse rounded-md bg-surface-2" />
          <div className="h-[32px] w-[104px] animate-pulse rounded-full bg-surface-2" />
        </div>

        <div className="flex gap-[6px] pt-[4px]">
          {[64, 96, 80].map((w, i) => (
            <div
              key={i}
              className="h-[30px] animate-pulse rounded-lg bg-control"
              style={{ width: w, animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>

        <div className="flex flex-col gap-[10px] pt-[8px]">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-[14px] rounded-xl bg-surface-2 p-[16px] animate-pulse"
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <div className="flex min-w-0 grow flex-col gap-[8px]">
                <div className="h-[15px] w-[62%] rounded bg-control" />
                <div className="h-[12px] w-[38%] rounded bg-control" />
              </div>
              <div className="hidden h-[13px] w-[120px] rounded bg-control md:block" />
              <div className="h-[32px] w-[72px] rounded-full bg-control" />
              <div className="h-[32px] w-[72px] rounded-full bg-control" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
