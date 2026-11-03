import { Suspense } from "react";
import { io } from "next/cache";
import { headers } from "next/headers";
import { clientAddressFrom } from "@/auth/client-address";
import { authThrottleLockExpiresAt, ipThrottleKey, lockoutMessage } from "@/auth/throttle";
import { AuthScreen } from "@/components/monitor/auth-screen";
import { withClient } from "@/db/pg";
import { signInAction } from "./actions";

async function SignInScreen() {
  await io();
  let lockExpiresAt: string | null = null;
  let lockMessage: string | null = null;
  if (process.env.DATABASE_URL?.trim()) {
    try {
      const headerList = await headers();
      const ip = clientAddressFrom(headerList.get("x-forwarded-for"), headerList.get("x-real-ip"));
      const key = ipThrottleKey(ip);
      if (key) {
        const lock = await withClient((db) => authThrottleLockExpiresAt(db, [key]));
        if (lock) {
          lockExpiresAt = lock.expiresAt.toISOString();
          lockMessage = lockoutMessage(lock.retryMinutes);
        }
      }
    } catch (error) {
      console.error("sign-in lockout lookup failed", error instanceof Error ? error.message : error);
    }
  }
  return (
    <AuthScreen
      title="Masuk ke Sentiment Monitor"
      lede="Masuk untuk melihat sentimen merek Anda hari ini."
      action={signInAction}
      submitLabel="Masuk"
      alternateHref="/daftar"
      alternatePrompt="Belum punya akun?"
      alternateLabel="Daftar"
      mode="sign-in"
      lockExpiresAt={lockExpiresAt}
      lockMessage={lockMessage}
    />
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInScreen />
    </Suspense>
  );
}
