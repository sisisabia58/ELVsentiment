import type { RouteDecision, ScoringPolicy } from "./routing";

export type AttentionItem = {
  id: string;
  mentionId: string;
  customerId: string;
  reason: "negative";
  unread: boolean;
};

export type AttentionDecision =
  | { eligible: false; route: "not_sure" | "none" }
  | { eligible: true; reason: "negative" };

export function highImpactReason(): null {
  return null;
}

export function attentionDecision(
  input: { mentionId: string; route: RouteDecision; sentimentConfidence: number | null },
  policy: ScoringPolicy,
): AttentionDecision {
  if (
    !policy.approved ||
    policy.attentionNegativeConfidenceMin === null ||
    input.route.bucket === "not_sure" ||
    input.route.bucket === "policy_unapproved" ||
    input.route.sentimentUncertain
  ) {
    return { eligible: false, route: "not_sure" };
  }
  const confident =
    input.route.bucket === "included" &&
    input.route.sentiment === "negative" &&
    input.sentimentConfidence !== null &&
    input.sentimentConfidence >= policy.attentionNegativeConfidenceMin;
  if (!confident) return { eligible: false, route: "none" };
  return { eligible: true, reason: "negative" };
}

export function dedupeAttention(items: readonly AttentionItem[]): {
  items: AttentionItem[];
  droppedMentionIds: string[];
} {
  const seen = new Set<string>();
  const kept: AttentionItem[] = [];
  const droppedMentionIds: string[] = [];
  for (const item of items) {
    if (seen.has(item.mentionId)) {
      droppedMentionIds.push(item.mentionId);
      continue;
    }
    seen.add(item.mentionId);
    kept.push(item);
  }
  return { items: kept, droppedMentionIds };
}

export function markSeen(
  item: AttentionItem,
  persist: (next: AttentionItem) => void,
): { ok: true; item: AttentionItem } | { ok: false; error: string; item: AttentionItem } {
  const next = { ...item, unread: false };
  try {
    persist(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "persist_failed";
    return { ok: false, error: message, item };
  }
  return { ok: true, item: next };
}
