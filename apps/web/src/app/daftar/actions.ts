"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientAddressFrom } from "@/auth/client-address";
import { signUp } from "@/auth/forms";
import { setSessionCookie } from "@/auth/request-session";
import type { AuthFormState } from "@/components/auth-form";
import { withClient } from "@/db/pg";

export async function signUpAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const headerList = await headers();
  const input = {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    displayName: String(formData.get("name") ?? ""),
    confirm: String(formData.get("confirm") ?? ""),
    ip: clientAddressFrom(headerList.get("x-forwarded-for"), headerList.get("x-real-ip")),
  };
  const result = await withClient((db) => signUp(db, input));
  if ("error" in result) return { error: result.error, lockExpiresAt: result.lockExpiresAt ?? null };
  await setSessionCookie(result.token);
  redirect("/onboarding");
}
