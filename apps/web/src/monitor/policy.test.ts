import { describe, expect, it } from "vitest";
import { readMonitorPolicy } from "./policy";

const PROPOSED_NUMBERS = {
  relevanceExcludeMax: 0.35,
  relevanceIncludeMin: 0.75,
  sentimentConfidenceMin: 0.7,
  topicNoulMin: 0.65,
  attentionNegativeConfidenceMin: 0.85,
};

const TOPIC_IDS = [
  "harga",
  "kualitas",
  "layanan",
  "pengiriman",
  "promo",
  "stok",
  "kemasan",
  "pengalaman",
];

describe("readMonitorPolicy", () => {
  it("returns the five proposed threshold numbers", () => {
    const { scoring } = readMonitorPolicy();
    expect(scoring.relevanceExcludeMax).toBe(PROPOSED_NUMBERS.relevanceExcludeMax);
    expect(scoring.relevanceIncludeMin).toBe(PROPOSED_NUMBERS.relevanceIncludeMin);
    expect(scoring.sentimentConfidenceMin).toBe(PROPOSED_NUMBERS.sentimentConfidenceMin);
    expect(scoring.topicNoulMin).toBe(PROPOSED_NUMBERS.topicNoulMin);
    expect(scoring.attentionNegativeConfidenceMin).toBe(PROPOSED_NUMBERS.attentionNegativeConfidenceMin);
  });

  it("keeps high impact off per launch config", () => {
    expect(readMonitorPolicy().highImpact).toBe(false);
  });

  it("loads eight topic labels and lainnya fallback from repo config", () => {
    const policy = readMonitorPolicy();
    expect(policy.scoring.fallbackTopicId).toBe("lainnya");
    expect(policy.topicLabels).toHaveLength(8);
    expect(policy.topicLabels.map((label) => label.id)).toEqual(TOPIC_IDS);
    for (const label of policy.topicLabels) {
      expect(label).toEqual(expect.objectContaining({ id: expect.any(String), label: expect.any(String) }));
      expect(label).not.toHaveProperty("instructions");
    }
  });

  it("exposes topicQuestions for scoring without the fallback id", () => {
    const { topicQuestions } = readMonitorPolicy();
    expect(topicQuestions).toHaveLength(8);
    expect(topicQuestions.map((question) => question.id)).toEqual(TOPIC_IDS);
    expect(topicQuestions.some((question) => question.id === "lainnya")).toBe(false);
    for (const question of topicQuestions) {
      expect(question.instructions.trim().length).toBeGreaterThan(0);
    }
  });
});
