"use server";

import { withSessionDeps } from "@/auth/request-session";
import { customerIdFromSessionToken } from "@/auth/session";
import { readSearchLimits } from "@/monitor/search/limits";
import {
  startSearchForCustomer,
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
