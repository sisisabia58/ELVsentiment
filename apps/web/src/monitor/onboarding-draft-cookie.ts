import { cookies, headers } from "next/headers";
import { sessionCookieOptions, type SessionCookieContext } from "@/auth/accounts";
import { sessionCustomerId } from "@/auth/request-session";
import { withClient } from "@/db/pg";
import { loadScheduledSourceAvailability } from "@/monitor/policy";
import {
  allowedOnboardingStep,
  bindOnboardingDraft,
  ONBOARDING_DRAFT_COOKIE,
  ONBOARDING_DRAFT_MAX_AGE_SECONDS,
  parseOnboardingDraft,
  workingSources,
  type OnboardingDraft,
  type OnboardingDraftFields,
} from "./onboarding-draft";

export function onboardingDraftCookieOptions(context: SessionCookieContext = {}) {
  return {
    ...sessionCookieOptions(context),
    maxAge: ONBOARDING_DRAFT_MAX_AGE_SECONDS,
  };
}

async function cookieContext(): Promise<SessionCookieContext> {
  const forwardedProto = (await headers()).get("x-forwarded-proto");
  return { nodeEnv: process.env.NODE_ENV, forwardedProto };
}

export async function writeOnboardingDraftCookie(
  fields: OnboardingDraftFields,
  initiatedCari?: Pick<OnboardingDraft, "originSearchId" | "cariAttemptId"> & { customerId: string },
): Promise<boolean> {
  const customerId = await sessionCustomerId();
  if (!customerId) return false;
  const credentials = await withClient(loadScheduledSourceAvailability);
  const allowed = allowedOnboardingStep({
    brand: fields.brand,
    keywords: fields.keywords,
    sources: workingSources(fields.sources, credentials),
    credentials,
  });
  const jar = await cookies();
  const prior = fields.importSearchPosts !== undefined
    ? parseOnboardingDraft(jar.get(ONBOARDING_DRAFT_COOKIE)?.value) : null;
  const cari = initiatedCari ?? prior;
  const draft = bindOnboardingDraft(
    customerId, { ...fields, step: Math.min(fields.step, allowed) },
    cari?.customerId === customerId ? cari : undefined,
  );
  if (!draft) return false;
  jar.set(
    ONBOARDING_DRAFT_COOKIE,
    JSON.stringify(draft),
    onboardingDraftCookieOptions(await cookieContext()),
  );
  return true;
}

export async function clearOnboardingDraftCookie(): Promise<void> {
  (await cookies()).set(ONBOARDING_DRAFT_COOKIE, "", {
    ...onboardingDraftCookieOptions(await cookieContext()),
    maxAge: 0,
  });
}
