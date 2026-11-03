"use server";

import { clearOnboardingDraftCookie, writeOnboardingDraftCookie } from "@/monitor/onboarding-draft-cookie";
import type { OnboardingDraftFields } from "@/monitor/onboarding-draft";

export async function saveOnboardingDraftAction(fields: OnboardingDraftFields): Promise<void> {
  await writeOnboardingDraftCookie(fields);
}

export async function clearOnboardingDraftAction(): Promise<void> {
  await clearOnboardingDraftCookie();
}
