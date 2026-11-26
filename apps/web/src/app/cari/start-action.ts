"use server";

import { withSessionDeps } from "@/auth/request-session";
import { writeOnboardingDraftCookie } from "@/monitor/onboarding-draft-cookie";
import { customerIdFromSessionToken } from "@/auth/session";
import type { Queryable } from "@/db/migrate";
import type { ReviewKey } from "@/monitor/search/review-result";
import {
  readCariReview, routeCariResult, undoCariRoute, type RouteInput, type UndoInput,
  type ReviewReadResult, type ReviewWriteResult,
} from "@/monitor/search/review-routing";
import { readSearchLimits } from "@/monitor/search/limits";
import { requestMoreSource, type RequestMoreResult } from "@/monitor/search/more-source";
import {
  askQuestionForCustomer,
  monitorAsProjectForCustomer,
  retryQuestionForCustomer,
  startSearchForCustomer,
  type AskQuestionResult,
  type MonitorProjectResult,
  type StartSearchInput,
  type StartSearchResult,
} from "./actions";

export async function startSearchAction(
  input: StartSearchInput | null | undefined,
): Promise<StartSearchResult> {
  const query = (input as { query?: unknown } | null | undefined)?.query;
  const filters = (input as { filters?: StartSearchInput["filters"] } | null | undefined)?.filters;
  return withSessionDeps(async (deps) => {
    let customerId: string;
    try {
      customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    } catch {
      return { ok: false as const, error: "unauthenticated" };
    }
    return startSearchForCustomer({
      db: deps.db,
      customerId,
      query: query as string,
      filters: filters as StartSearchInput["filters"],
      env: process.env,
      limits: readSearchLimits(),
      now: new Date(),
    });
  });
}

export async function askQuestionAction(
  searchId: string,
  question: string,
): Promise<AskQuestionResult> {
  return withSessionDeps(async (deps) => {
    let customerId: string;
    try {
      customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    } catch {
      return { ok: false as const, error: "unauthenticated" };
    }
    return askQuestionForCustomer({
      db: deps.db,
      customerId,
      searchId,
      question,
      env: process.env,
    });
  });
}

export async function retryQuestionAction(
  searchId: string,
  questionId: string,
): Promise<AskQuestionResult> {
  return withSessionDeps(async (deps) => {
    let customerId: string;
    try {
      customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    } catch {
      return { ok: false as const, error: "unauthenticated" };
    }
    return retryQuestionForCustomer({
      db: deps.db,
      customerId,
      searchId,
      questionId,
      env: process.env,
    });
  });
}

export async function monitorAsProjectAction(searchId: string): Promise<MonitorProjectResult> {
  return withSessionDeps(async (deps) => {
    let customerId: string;
    try {
      customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    } catch {
      return { ok: false as const, error: "unauthenticated" };
    }
    const prepared = await monitorAsProjectForCustomer({
      db: deps.db,
      customerId,
      searchId,
      env: process.env,
    });
    if (!prepared.ok) return prepared;
    const wrote = await writeOnboardingDraftCookie(prepared.fields, {
      customerId, originSearchId: prepared.originSearchId, cariAttemptId: prepared.cariAttemptId,
    });
    if (!wrote) return { ok: false as const, error: "unauthenticated" };
    return prepared;
  });
}

export async function startMoreSourceAction(
  searchId: string,
  platform: string,
  generation: number,
): Promise<RequestMoreResult> {
  return withSessionDeps(async (deps) => {
    let customerId: string;
    try {
      customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    } catch {
      return { ok: false as const, error: "unauthenticated" };
    }
    return requestMoreSource({
      db: deps.db,
      customerId,
      searchId,
      platform,
      generation,
      dailyLimit: readSearchLimits().cariDailySearchLimit,
    });
  });
}

async function withReviewSession<T>(action: (ctx: {
  db: Queryable; customerId: string; env: NodeJS.ProcessEnv;
}) => Promise<T>) {
  return withSessionDeps(async (deps) => {
    let customerId: string;
    try {
      customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    } catch {
      return { ok: false as const, error: "unauthenticated" as const };
    }
    return action({ db: deps.db, customerId, env: process.env });
  });
}

export async function readCariReviewAction(key: ReviewKey): Promise<ReviewReadResult> {
  return withReviewSession((ctx) => readCariReview(ctx, key));
}

export async function routeCariResultAction(input: RouteInput): Promise<ReviewWriteResult> {
  return withReviewSession((ctx) => routeCariResult(ctx, input));
}

export async function undoCariRouteAction(input: UndoInput): Promise<ReviewWriteResult> {
  return withReviewSession((ctx) => undoCariRoute(ctx, input));
}
