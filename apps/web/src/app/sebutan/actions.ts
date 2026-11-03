"use server";

import { refresh } from "next/cache";
import { withSessionDeps } from "@/auth/request-session";
import { customerIdFromSessionToken } from "@/auth/session";
import { saveMentionReview, setMentionRead } from "@/monitor/mutations";
import type { Sentiment } from "@/monitor/present";

export async function markReadAction(mentionId: string, read: boolean): Promise<{ ok: boolean }> {
  const result = await withSessionDeps(async (deps) => {
    const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    return setMentionRead(deps.db, customerId, mentionId, read);
  });
  refresh();
  return { ok: result.ok };
}

export async function saveReviewAction(
  mentionId: string,
  input: { relevance: "relevant" | "irrelevant"; sentiment: Sentiment | null; topics: string[] },
): Promise<{ ok: true; action: "confirm" | "correct"; error: null } | { ok: false; action: null; error: string }> {
  const result = await withSessionDeps(async (deps) => {
    const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    return saveMentionReview(deps.db, customerId, mentionId, input);
  });
  if (!result.ok) {
    return {
      ok: false,
      action: null,
      error: result.reason === "invalid" ? "Pilih penilaian untuk melanjutkan." : "Perubahan belum tersimpan. Coba lagi.",
    };
  }
  refresh();
  return { ok: true, action: result.action, error: null };
}
