import { execSync } from "node:child_process";

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function list(key: string): string[] {
  return (env(key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * In local development, prefer the token managed by `gh`: shell-level
 * GITHUB_TOKEN values are often stale and override the healthy keychain token.
 * Production has no `gh` binary, so it uses GITHUB_TOKEN as normal.
 */
function resolveGithubToken(): string | undefined {
  const fromEnv = env("GITHUB_TOKEN");
  if (process.env.NODE_ENV !== "production") {
    try {
      const local = execSync("gh auth token", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (local) return local;
    } catch {
      // No local gh session; fall through to the explicit environment token.
    }
  }
  return fromEnv;
}

export const config = {
  githubToken: resolveGithubToken(),
  // The queue only shows PRs with activity inside this window, so the list is
  // always "active this week" - no client toggle needed. These are product
  // rules, not deployment knobs: stale shell variables must not silently turn
  // the global 50-PR queue back into 10 or widen the seven-day window.
  maxPrAgeDays: 7,
  maxPrs: 50,
  repos: list("GITHUB_REPOS"),
  mergeMethod: (env("GITHUB_MERGE_METHOD") ?? "squash") as
    | "squash"
    | "merge"
    | "rebase",
  requireGreenCI: (env("REQUIRE_GREEN_CI") ?? "true") !== "false",
  blockingBots: list("BLOCKING_BOTS").map((b) => b.toLowerCase()),
  githubWebhookSecret: env("GITHUB_WEBHOOK_SECRET"),

  linearApiKey: env("LINEAR_API_KEY"),

  supabaseUrl: env("SUPABASE_URL"),
  supabaseKey: env("SUPABASE_SERVICE_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseTable: env("SUPABASE_USERS_TABLE") ?? "users",
  supabaseEmailCol: env("SUPABASE_EMAIL_COLUMN") ?? "email",
  mergeDeskQueueTable:
    env("MERGE_DESK_QUEUE_TABLE") ?? "merge_desk_queue_items",
  mergeDeskSummaryTable:
    env("MERGE_DESK_SUMMARY_TABLE") ?? "merge_desk_summaries",
  mergeDeskStateTable:
    env("MERGE_DESK_STATE_TABLE") ?? "merge_desk_state",

  posthogHost: env("POSTHOG_HOST") ?? env("POSTHOG_APP_HOST") ?? "https://us.posthog.com",
  // Persons search needs the personal API key, not the project key.
  posthogKey: env("POSTHOG_PERSONAL_API_KEY") ?? env("POSTHOG_API_KEY"),
  posthogProject: env("POSTHOG_PROJECT_ID"),

  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001",

  // Our own identity, so a support thread's vendor side is never mistaken for
  // the customer. These are the addresses/names on the *receiving* end of a
  // report (e.g. harsha@slashy.com, "Slashy").
  ownEmailDomains: list("OWN_EMAIL_DOMAINS"),
  ownCompanyNames: list("OWN_COMPANY_NAMES"),

  // Shared password for the web UI. Machine callers (scripts, curl) can use a
  // token from MQ_ACCESS_TOKENS instead of signing in.
  password: env("MQ_PASSWORD"),
  accessTokens: list("MQ_ACCESS_TOKENS"),

  slackBotToken: env("SLACK_BOT_TOKEN"),
  slackSigningSecret: env("SLACK_SIGNING_SECRET"),
  slackChannelId: env("SLACK_CHANNEL_ID"),
  slackTargetUserId: env("SLACK_TARGET_USER_ID"),
  slackMergeUserIds: list("SLACK_MERGE_USER_IDS"),
  slackPublishSecret: env("SLACK_PUBLISH_SECRET") ?? env("CRON_SECRET"),
};

/**
 * Mock mode: no GitHub token means we serve fake data so the UI runs
 * with zero credentials. Flip to live by setting GITHUB_TOKEN + GITHUB_REPOS.
 */
export const isMockMode = !config.githubToken || config.repos.length === 0;

/**
 * Whether callers must prove who they are.
 *
 * An unconfigured password means "open" only outside production. A deployed
 * instance with nothing configured fails closed instead: this surface lists
 * every waiting customer's email address and can squash-merge production
 * branches, so the safe default when it is reachable from the internet is to
 * refuse, not to serve.
 */
export function authRequired(): boolean {
  return Boolean(config.password) || process.env.NODE_ENV === "production";
}
