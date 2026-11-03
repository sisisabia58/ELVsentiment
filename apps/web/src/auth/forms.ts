import type { Queryable } from "../db/migrate";
import { authenticateOwner, openSession, registerOwner } from "./accounts";
import { authThrottleKeys, authThrottleLockExpiresAt, clearAuthThrottle, lockoutMessage, recordAuthFailure } from "./throttle";

export type AuthFormResult = { token: string } | { error: string; lockExpiresAt?: string | null };

function lockoutResult(lock: { expiresAt: Date; retryMinutes: number }): AuthFormResult {
  return { error: lockoutMessage(lock.retryMinutes), lockExpiresAt: lock.expiresAt.toISOString() };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

function emailError(email: string): string | null {
  if (!email) return "Masukkan alamat email.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Masukkan alamat email yang valid.";
  return null;
}

export async function signUp(
  db: Queryable,
  input: { email: string; password: string; ip?: string; displayName?: string; confirm?: string },
): Promise<AuthFormResult> {
  const email = input.email.trim();
  // app.login_email reads back as '' on a pooled connection that set it in an
  // earlier transaction. users_email_lookup ignores '', and no row should hold it.
  const invalidEmail = emailError(email);
  if (invalidEmail) return { error: invalidEmail };
  if (input.displayName !== undefined && input.displayName.trim() === "") return { error: "Masukkan nama Anda." };
  if (!input.password) return { error: "Masukkan kata sandi." };
  if (input.password.length < 8) return { error: "Kata sandi minimal 8 karakter." };
  if (input.confirm !== undefined && input.confirm !== input.password) {
    return { error: "Konfirmasi kata sandi belum sesuai." };
  }
  const keys = authThrottleKeys(email, input.ip);
  const lock = await authThrottleLockExpiresAt(db, keys);
  if (lock) return lockoutResult(lock);
  let owner: { customerId: string; userId: string };
  try {
    owner = await registerOwner(db, {
      email,
      password: input.password,
      displayName: input.displayName?.trim() || null,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await recordAuthFailure(db, keys);
      return { error: "Email ini sudah terdaftar." };
    }
    throw error;
  }
  await clearAuthThrottle(db, keys);
  const session = await openSession(db, owner.userId, owner.customerId);
  return { token: session.token };
}

export async function signIn(
  db: Queryable,
  input: { email: string; password: string; ip?: string },
): Promise<AuthFormResult> {
  const email = input.email.trim();
  const invalidEmail = emailError(email);
  if (invalidEmail) return { error: invalidEmail };
  if (!input.password) return { error: "Masukkan kata sandi." };
  const keys = authThrottleKeys(email, input.ip);
  const lock = await authThrottleLockExpiresAt(db, keys);
  if (lock) return lockoutResult(lock);
  const owner = await authenticateOwner(db, email, input.password);
  if (!owner) {
    await recordAuthFailure(db, keys);
    return { error: "Email atau kata sandi salah." };
  }
  await clearAuthThrottle(db, keys);
  const session = await openSession(db, owner.userId, owner.customerId);
  return { token: session.token };
}
