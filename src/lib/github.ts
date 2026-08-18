import { config } from "./config";
import type { CiState, ReviewGate } from "./types";

const API = "https://api.github.com";

function headers() {
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

export interface RawPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  createdAt: string;
  /** Last activity (commit, comment, label...). What "recent" is judged on. */
  updatedAt: string;
  headRef: string;
  body: string;
  gate: ReviewGate;
}

const RETRY_DELAYS_MS = [400, 1200, 2500];

/*
  GitHub intermittently answers a valid query with "No server is currently
  available to service your request" - a transient backend failure, not a
  rejection. It arrives as a 200 carrying an errors array as often as a 5xx,
  so both shapes are retried before the queue is failed.
*/
function isTransient(status: number, detail: string): boolean {
  if (status === 502 || status === 503 || status === 504) return true;
  return /no server is currently available|timeout|try again|secondary rate limit/i.test(
    detail,
  );
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  label: string,
): Promise<T> {
  let lastDetail = "unknown error";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let status = 0;
    try {
      const res = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: headers(),
        cache: "no-store",
        body: JSON.stringify({ query, variables }),
      });
      status = res.status;
      const json = (await res.json().catch(() => ({}))) as {
        data?: T;
        errors?: Array<{ message?: string }>;
        message?: string;
      };

      if (res.ok && !json.errors?.length && json.data) return json.data;

      lastDetail =
        json.errors?.map((error) => error.message).filter(Boolean).join("; ") ||
        json.message ||
        `HTTP ${res.status}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : "network error";
      status = 0;
    }

    const retryable = status === 0 || isTransient(status, lastDetail);
    if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }

  throw new Error(`GitHub ${label} failed: ${lastDetail}`);
}

function gateFromPullRequest(pr: any, reviewThreads?: any[]): ReviewGate {
  const rollup = pr?.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.state;
  let ciState: CiState = "passing";
  if (config.requireGreenCI) {
    if (rollup === "FAILURE" || rollup === "ERROR") ciState = "failing";
    else if (rollup && rollup !== "SUCCESS") ciState = "pending";
  }

  const threads: any[] = reviewThreads ?? pr?.reviewThreads?.nodes ?? [];
  const blocking = new Set(config.blockingBots);
  const bots = new Set<string>();
  let count = 0;
  for (const t of threads) {
    if (t.isResolved) continue;
    const author = t.comments?.nodes?.[0]?.author;
    if (!author) continue;
    const login = (author.login ?? "").toLowerCase();
    const isBot = author.__typename === "Bot" || login.endsWith("[bot]");
    if (!isBot) continue;
    // If blockingBots configured, only those count; otherwise any bot counts.
    if (blocking.size > 0 && !blocking.has(login)) continue;
    count += 1;
    bots.add(author.login);
  }
  return {
    ciGreen: ciState === "passing",
    ciState,
    unresolvedBotReviews: count,
    blockingBots: [...bots],
  };
}

/**
 * One GraphQL request returns the repository's recent PRs, CI rollups, and
 * review threads.
 *
 * Threads were previously fetched through a second request built from flat
 * per-PR aliases, to avoid multiplying the connection cost. That query turned
 * out to be the expensive shape: GitHub rejected it intermittently with "No
 * server is currently available to service your request", failing the whole
 * queue. Nesting the connection costs 51 points of the 5000/hour budget for a
 * full 50-PR page and removes a sequential round trip.
 */
export async function listOpenPRs(
  repo: string,
  count = config.maxPrs,
): Promise<RawPR[]> {
  const [owner, name] = repo.split("/");
  const query = `
    query Queue($owner:String!,$repo:String!,$count:Int!){
      repository(owner:$owner,name:$repo){
        pullRequests(
          first:$count
          states:OPEN
          orderBy:{field:UPDATED_AT,direction:DESC}
        ){
          nodes{
            number title url createdAt updatedAt headRefName body
            author{ login }
            commits(last:1){
              nodes{ commit{ statusCheckRollup{ state } } }
            }
            reviewThreads(first:100){
              nodes{
                isResolved
                comments(first:1){
                  nodes{ author{ __typename login } }
                }
              }
            }
          }
        }
      }
    }`;
  const data = await graphql<any>(
    query,
    { owner, repo: name, count: Math.min(count, 100) },
    `queue query for ${repo}`,
  );
  const cutoff = Date.now() - config.maxPrAgeDays * 24 * 60 * 60 * 1000;
  const nodes: any[] = data?.repository?.pullRequests?.nodes ?? [];
  return nodes
    .filter((pr) => new Date(pr.updatedAt).getTime() >= cutoff)
    .map((pr) => ({
      repo,
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? "unknown",
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      headRef: pr.headRefName ?? "",
      body: pr.body ?? "",
      gate: gateFromPullRequest(pr),
    }));
}

export async function evaluateGate(
  repo: string,
  prNumber: number,
): Promise<ReviewGate> {
  const [owner, name] = repo.split("/");
  const query = `
    query Gate($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          commits(last:1){
            nodes{ commit{ statusCheckRollup{ state } } }
          }
          reviewThreads(first:100){
            nodes{
              isResolved
              comments(first:1){
                nodes{ author{ __typename login } }
              }
            }
          }
        }
      }
    }`;
  const data = await graphql<any>(
    query,
    { owner, repo: name, number: prNumber },
    `merge-gate query for ${repo}#${prNumber}`,
  );
  const pr = data?.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub PR not found: ${repo}#${prNumber}`);
  return gateFromPullRequest(pr);
}

/**
 * The description and touched paths for one PR. Fetched lazily when a summary
 * is actually requested - the queue itself never needs it, and pulling it for
 * every row would double the page's API cost.
 */
export async function getPullRequestContext(
  repo: string,
  prNumber: number,
): Promise<{ body: string; files: string[] }> {
  const [owner, name] = repo.split("/");
  const query = `
    query Context($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          body
          files(first:100){ nodes{ path } }
        }
      }
    }`;
  const data = await graphql<any>(
    query,
    { owner, repo: name, number: prNumber },
    `summary-context query for ${repo}#${prNumber}`,
  );
  const pr = data?.repository?.pullRequest;
  return {
    body: pr?.body ?? "",
    files: (pr?.files?.nodes ?? [])
      .map((file: any) => file?.path)
      .filter((path: unknown): path is string => typeof path === "string"),
  };
}

export async function mergePR(
  repo: string,
  prNumber: number,
): Promise<{ merged: boolean; message: string }> {
  const [owner, name] = repo.split("/");
  try {
    const idQuery = `
      query PullRequestId($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$number){ id }
        }
      }`;
    const idData = await graphql<any>(
      idQuery,
      { owner, repo: name, number: prNumber },
      `merge lookup for ${repo}#${prNumber}`,
    );
    const pullRequestId = idData?.repository?.pullRequest?.id;
    if (!pullRequestId) {
      return { merged: false, message: "Pull request not found" };
    }

    const mutation = `
      mutation Merge(
        $pullRequestId:ID!
        $method:PullRequestMergeMethod!
      ){
        mergePullRequest(
          input:{pullRequestId:$pullRequestId,mergeMethod:$method}
        ){
          pullRequest{ merged }
        }
      }`;
    const data = await graphql<any>(
      mutation,
      {
        pullRequestId,
        method: config.mergeMethod.toUpperCase(),
      },
      `merge mutation for ${repo}#${prNumber}`,
    );
    const merged = data?.mergePullRequest?.pullRequest?.merged === true;
    return {
      merged,
      message: merged ? "Merged successfully" : "GitHub did not merge the PR",
    };
  } catch (error) {
    return {
      merged: false,
      message: error instanceof Error ? error.message : "Merge failed",
    };
  }
}
