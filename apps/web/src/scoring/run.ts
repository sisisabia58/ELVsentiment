import type { Queryable } from "../db/migrate";
import { routeJudgment } from "../domain/routing";
import { buildSystemOneBody, parseSystemOne, scoreWithFallback, TYPESAFE_MODEL } from "../jev/client";
import { isRetryable, postWithRetry, redactAuthorization, type JevError } from "../jev/retry";
import { readMonitorPolicy } from "../monitor/policy";
import {
  claimPendingBatch,
  reclaimStaleClaims,
  recordSuccess,
  recordWorkerSuccess,
  settleOwnedAttempt,
  touchScoringClaim,
} from "./jobs";

type MonitorPolicy = ReturnType<typeof readMonitorPolicy>;
type SystemOneResponse = Parameters<typeof parseSystemOne>[0];

export type ScoreDeps = {
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  post: (body: unknown, apiKey: string) => Promise<unknown>;
  limit?: number;
  role: "web" | "worker";
  customerId?: string;
  policy?: MonitorPolicy;
};

export type ScoreDecision = {
  mentionId: string;
  bucket: string;
  relevance: string;
  topics: string[];
  sentimentUncertain: boolean;
};

export type ScoreResult = {
  scored: number;
  failed: number;
  skipped: "missing_api_key" | null;
  decisions: ScoreDecision[];
};

function asSystemOne(value: unknown): SystemOneResponse {
  if (typeof value !== "object" || value === null) throw new Error("invalid_judgment");
  const record = value as { model?: unknown; answers?: unknown };
  if (typeof record.model !== "string" || typeof record.answers !== "object" || record.answers === null) {
    throw new Error("invalid_judgment");
  }
  return value as SystemOneResponse;
}

async function fallbackDisabled(): Promise<SystemOneResponse> {
  throw new Error("fallback_disabled");
}

function failureReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as { status?: unknown; timeout?: unknown; message?: unknown };
    const parts = ["scoring failed"];
    if (typeof record.status === "number") parts.push(`status ${record.status}`);
    if (record.timeout === true) parts.push("timeout");
    if (typeof record.message === "string") parts.push(record.message);
    return parts.join(": ");
  }
  return `scoring failed: ${String(error)}`;
}

function isJobRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as JevError;
  if (record.network === true) return true;
  return isRetryable(record);
}

export async function scoreUnscoredMentions(db: Queryable, deps: ScoreDeps): Promise<ScoreResult> {
  const apiKey = deps.env.TYPESAFE_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    deps.log("scoring skipped: TYPESAFE_API_KEY is not set");
    return { scored: 0, failed: 0, skipped: "missing_api_key", decisions: [] };
  }
  if (deps.role === "web" && !deps.customerId) throw new Error("customer_required");

  const monitor = deps.policy ?? readMonitorPolicy();
  const scopedToCustomer = deps.role === "web";
  await reclaimStaleClaims(db, scopedToCustomer ? deps.customerId : undefined);
  const claimed = await claimPendingBatch(db, deps.limit ?? 5, scopedToCustomer ? deps.customerId : undefined);
  const key = apiKey.trim();
  let scored = 0;
  let failed = 0;
  const decisions: ScoreDecision[] = [];

  for (const mention of claimed) {
    const claimToken = await touchScoringClaim(
      db,
      mention.customerId,
      mention.id,
      mention.attempts,
      scopedToCustomer,
    );
    if (!claimToken) continue;
    try {
      const body = buildSystemOneBody({
        model: TYPESAFE_MODEL,
        brandName: mention.brandName,
        text: mention.excerpt,
        topics: monitor.topicQuestions,
      });
      let raw: unknown;
      const primary = async (request: unknown) => {
        const response = await postWithRetry((posted, postedKey) => deps.post(posted, postedKey), request, key, {
          sleep: deps.sleep,
          random: deps.random,
          log: deps.log,
        });
        raw = response;
        return asSystemOne(response);
      };
      const result = await scoreWithFallback(body, { primary, fallback: fallbackDisabled }, false);
      const route = routeJudgment(result.judgment, monitor.scoring);
      const saved = {
        provider: result.provider,
        model: result.model,
        raw: raw ?? result.judgment,
        judgment: result.judgment,
      };
      const stored =
        deps.role === "web"
          ? await recordSuccess(db, mention.customerId, mention.id, saved, claimToken)
          : await recordWorkerSuccess(db, mention.customerId, mention.id, saved, claimToken);
      if (!stored) continue;
      decisions.push({
        mentionId: mention.id,
        bucket: route.bucket,
        relevance: route.relevance,
        topics: route.topics,
        sentimentUncertain: route.sentimentUncertain,
      });
      scored += 1;
    } catch (error) {
      deps.log(redactAuthorization(failureReason(error), key));
      try {
        const outcome = await settleOwnedAttempt(
          db,
          mention.customerId,
          mention.id,
          isJobRetryable(error),
          claimToken,
          scopedToCustomer,
        );
        if (outcome === "failed") failed += 1;
      } catch (updateError) {
        deps.log(redactAuthorization(failureReason(updateError), key));
      }
    }
  }

  return { scored, failed, skipped: null, decisions };
}
