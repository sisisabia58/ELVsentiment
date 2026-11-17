"use server";

import { withSessionDeps } from "@/auth/request-session";
import { customerIdFromSessionToken } from "@/auth/session";
import { readSearchLimits } from "@/monitor/search/limits";
import {
  askQuestionForCustomer,
  retryQuestionForCustomer,
  startSearchForCustomer,
  type AskQuestionResult,
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
