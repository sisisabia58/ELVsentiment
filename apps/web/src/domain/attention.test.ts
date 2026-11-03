import { describe, expect, it } from "vitest";
import { attentionDecision, dedupeAttention, highImpactReason, markSeen } from "./attention";
import type { RouteDecision, ScoringPolicy } from "./routing";

const policy: ScoringPolicy = {
  approved: true,
  relevanceExcludeMax: 0.2,
  relevanceIncludeMin: 0.8,
  sentimentConfidenceMin: 0.75,
  topicNoulMin: 0.7,
  attentionNegativeConfidenceMin: 0.8,
  fallbackTopicId: null,
};

const includedNegative: RouteDecision = {
  bucket: "included",
  relevance: "relevant",
  sentiment: "negative",
  sentimentUncertain: false,
  topics: ["harga"],
  topicsUncertain: false,
  topicSource: "thresholds",
};

describe("attentionDecision", () => {
  it("accepts one confident negative mention", () => {
    expect(attentionDecision({ mentionId: "m1", route: includedNegative, sentimentConfidence: 0.91 }, policy)).toEqual({
      eligible: true,
      reason: "negative",
    });
  });

  it("sends a low-confidence negative mention to review", () => {
    const route: RouteDecision = { ...includedNegative, bucket: "not_sure", sentimentUncertain: true };
    expect(attentionDecision({ mentionId: "m1", route, sentimentConfidence: 0.4 }, policy)).toEqual({
      eligible: false,
      route: "not_sure",
    });
  });

  it("does not invent a high-impact reason", () => {
    expect(highImpactReason()).toBeNull();
  });
});

describe("dedupeAttention", () => {
  it("keeps the first item for a mention", () => {
    const item = { id: "a", mentionId: "m1", customerId: "c1", reason: "negative" as const, unread: true };
    const duplicate = { ...item, id: "b" };
    expect(dedupeAttention([item, duplicate])).toEqual({ items: [item], droppedMentionIds: ["m1"] });
  });
});

describe("markSeen", () => {
  it("reports a persist failure without clearing unread", () => {
    const item = { id: "a", mentionId: "m1", customerId: "c1", reason: "negative" as const, unread: true };
    const result = markSeen(item, () => {
      throw new Error("db_down");
    });
    expect(result).toEqual({ ok: false, error: "db_down", item });
  });
});
