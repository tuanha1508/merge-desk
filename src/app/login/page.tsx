export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-[24px]">
      <form
        action="/api/login"
        method="post"
        className="flex w-full max-w-[360px] flex-col gap-[16px]"
      >
        <div className="flex flex-col gap-[6px]">
          <h1 className="text-[24px] font-semibold leading-[31px] tracking-[-0.02em] text-text">
            Merge control
          </h1>
          <p className="text-[14px] leading-[20px] text-text-2">
            This queue lists customer contact details and can merge production
            branches. Sign in to continue.
          </p>
        </div>

        {next && <input type="hidden" name="next" value={next} />}

        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Password"
          aria-invalid={Boolean(error)}
          placeholder="Password"
          className="h-[40px] rounded-lg bg-surface-2 px-[14px] text-[15px] leading-[21px] text-text placeholder:text-text-faint"
        />

        {error === "locked" ? (
          <p role="alert" className="text-[14px] leading-[20px] text-warn">
            Too many failed attempts. Wait a few minutes and try again.
          </p>
        ) : error ? (
          <p role="alert" className="text-[14px] leading-[20px] text-warn">
            That password did not match.
          </p>
        ) : null}

        <button
          type="submit"
          className="flex h-[40px] items-center justify-center rounded-lg bg-accent px-[16px] text-[15px] font-medium leading-[21px] text-white transition hover:opacity-90 active:scale-[0.99]"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
