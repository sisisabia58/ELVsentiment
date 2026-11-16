"use server";

import { withSessionDeps } from "@/auth/request-session";
import { customerIdFromSessionToken } from "@/auth/session";
import { readSearchLimits } from "@/monitor/search/limits";
import {
  startSearchForCustomer,
  type StartSearchInput,
  type StartSearchResult,
} from "./actions";

export async function startSearchAction(input: StartSearchInput): Promise<StartSearchResult> {
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
      query: input.query,
      filters: input.filters,
      env: process.env,
      limits: readSearchLimits(),
      now: new Date(),
    });
  });
}
