import { cookies, headers } from "next/headers";
import { withClient } from "@/db/pg";
import { SESSION_COOKIE, sessionCookieOptions } from "./accounts";
import { customerIdFromSessionToken, type SessionActionDeps } from "./session";

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export function withSessionDeps<T>(fn: (deps: SessionActionDeps) => Promise<T>): Promise<T> {
  return withClient((db) => fn({ db, readSessionToken }));
}

export async function sessionCustomerId(): Promise<string | null> {
  const token = await readSessionToken();
  if (!token) return null;
  try {
    return await withClient((db) => customerIdFromSessionToken(db, token));
  } catch (error) {
    if (!(error instanceof Error && error.message === "unauthenticated")) {
      console.error("session lookup failed", error instanceof Error ? error.message : error);
    }
    return null;
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const forwardedProto = (await headers()).get("x-forwarded-proto");
  (await cookies()).set(
    SESSION_COOKIE,
    token,
    sessionCookieOptions({ nodeEnv: process.env.NODE_ENV, forwardedProto }),
  );
}

export async function clearSessionCookie(): Promise<void> {
  const forwardedProto = (await headers()).get("x-forwarded-proto");
  (await cookies()).set(SESSION_COOKIE, "", {
    ...sessionCookieOptions({ nodeEnv: process.env.NODE_ENV, forwardedProto }),
    maxAge: 0,
  });
}
