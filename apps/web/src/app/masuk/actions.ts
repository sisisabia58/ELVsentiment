"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signOut } from "@/auth/accounts";
import { clientAddressFrom } from "@/auth/client-address";
import { signIn } from "@/auth/forms";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "@/auth/request-session";
import { clearOnboardingDraftCookie } from "@/monitor/onboarding-draft-cookie";
import type { AuthFormState } from "@/components/auth-form";
import { withClient } from "@/db/pg";

export async function signInAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const headerList = await headers();
  const input = {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    ip: clientAddressFrom(headerList.get("x-forwarded-for"), headerList.get("x-real-ip")),
  };
  const result = await withClient((db) => signIn(db, input));
  if ("error" in result) return { error: result.error, lockExpiresAt: result.lockExpiresAt ?? null };
  await setSessionCookie(result.token);
  redirect("/dasbor");
}

export async function signOutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    try {
      await withClient((db) => signOut(db, token));
    } catch (error) {
      if (!(error instanceof Error && error.message === "unauthenticated")) {
        console.error("sign out failed", error instanceof Error ? error.message : error);
      }
    }
  }
  try {
    await clearSessionCookie();
  } finally {
    try {
      await clearOnboardingDraftCookie();
    } catch (error) {
      console.error("onboarding draft clear failed", error instanceof Error ? error.message : error);
    }
  }
  redirect("/masuk");
}
