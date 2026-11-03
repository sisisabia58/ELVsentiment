"use server";

import { refresh } from "next/cache";
import { saveDisplayName } from "@/auth/accounts";
import { withSessionDeps } from "@/auth/request-session";
import { customerIdFromSessionToken } from "@/auth/session";

export async function saveProfileAction(name: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const result = await withSessionDeps(async (deps) => {
    const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    return saveDisplayName(deps.db, customerId, name);
  });
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Perubahan profil tersimpan." };
}
