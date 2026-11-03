import { lockoutMessage, retryMinutesFromSeconds } from "./throttle";

const LOCKOUT_PREFIX = "Terlalu banyak percobaan.";

export function isLockoutMessage(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(LOCKOUT_PREFIX);
}

// The banner follows the server lock expiry only. A query string or cookie
// can still hold the text from an earlier attempt after the window has closed.
export function signInLockoutBanner(input: {
  now: Date;
  lockExpiresAt: Date | string | null | undefined;
  searchParams?: { error?: string | null } | null;
  cookie?: string | null;
}): string | null {
  void input.searchParams;
  void input.cookie;
  if (input.lockExpiresAt == null || input.lockExpiresAt === "") return null;
  const expires = input.lockExpiresAt instanceof Date ? input.lockExpiresAt : new Date(input.lockExpiresAt);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= input.now.getTime()) return null;
  const seconds = (expires.getTime() - input.now.getTime()) / 1000;
  return lockoutMessage(retryMinutesFromSeconds(seconds));
}

// How long to wait before asking the server again when the browser clock is
// already past a lock the server just confirmed. Refreshing immediately would loop.
export const LOCKOUT_CLIENT_CLOCK_REFRESH_MS = 60_000;

// `now` chooses the refresh delay only. It does not choose the banner text.
export function lockoutRefreshPlan(
  expiresAt: string | null | undefined,
  nowMs: number,
): { action: "wait"; ms: number } | { action: "refresh" } | null {
  if (expiresAt == null || expiresAt === "") return null;
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires)) return null;
  const remaining = expires - nowMs;
  if (remaining > 0) return { action: "wait", ms: remaining };
  return { action: "refresh" };
}

// The words on the banner are the server's. A client clock must not rewrite
// the minute count or hide a lock the server still considers active.
export function visibleAuthBanner(input: {
  now?: Date;
  nowMs?: number;
  error: string | null;
  actionLockExpiresAt?: string | null;
  serverLockExpiresAt?: string | null;
  lockMessage?: string | null;
}): string | null {
  if (input.error && !isLockoutMessage(input.error)) return input.error;
  if (isLockoutMessage(input.error)) return input.error;
  return input.lockMessage ?? null;
}
