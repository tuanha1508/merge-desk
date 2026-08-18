import { config, isMockMode } from "./config";
import { evaluateGate, mergePR } from "./github";
import { invalidateQueueCache, removeQueueItemEverywhere } from "./queue";
import type { MergeResult } from "./types";

export interface QueueMergeResult {
  result: MergeResult;
  status: number;
}

/**
 * The single merge path used by both the web UI and Slack. Gates are checked
 * immediately before every merge so neither client can act on stale status.
 *
 * The repo allowlist is enforced here (not only in Slack's button value) so a
 * signed-in web caller cannot aim the GitHub token at a repo outside
 * GITHUB_REPOS. Slack's splitPrRef check stays as a second line.
 */
export async function mergeQueueItem(
  repo: string,
  number: number,
): Promise<QueueMergeResult> {
  /*
    Answered before the allowlist, because the sample rows carry placeholder
    repos that are never in GITHUB_REPOS - checking first made the demo's merge
    button fail with "not in the merge queue". Mock mode means there is no
    GitHub token at all, so nothing can be merged for real here regardless.
  */
  if (isMockMode) {
    return {
      result: {
        ok: true,
        merged: true,
        message: `Mock merge of ${repo}#${number} (no real GitHub call)`,
      },
      status: 200,
    };
  }

  if (
    !config.repos.includes(repo) ||
    !Number.isInteger(number) ||
    number <= 0
  ) {
    return {
      result: {
        ok: false,
        merged: false,
        message: "Repository is not in the merge queue",
      },
      status: 403,
    };
  }

  const gate = await evaluateGate(repo, number);
  if (gate.unresolvedBotReviews > 0) {
    return {
      result: {
        ok: false,
        merged: false,
        message: "Blocked: unresolved bot reviews",
      },
      status: 409,
    };
  }

  if (!gate.ciGreen) {
    return {
      result: {
        ok: false,
        merged: false,
        message:
          gate.ciState === "pending"
            ? "Blocked: checks are still running"
            : "Blocked: required checks are failing",
      },
      status: 409,
    };
  }

  const merged = await mergePR(repo, number);
  if (merged.merged) {
    invalidateQueueCache();
    await removeQueueItemEverywhere(repo, number);
  }
  return {
    result: { ok: merged.merged, ...merged },
    status: merged.merged ? 200 : 409,
  };
}
