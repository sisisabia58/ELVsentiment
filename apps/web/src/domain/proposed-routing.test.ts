import { describe, expect, it } from "vitest";
import { attentionDecision } from "./attention";
import { readMonitorPolicy } from "../monitor/policy";
import { routeJudgment, type ScoringPolicy } from "./routing";

function approvedProposedPolicy(): ScoringPolicy {
  return { ...readMonitorPolicy().scoring, approved: true };
}

describe("proposed routing thresholds", () => {
  const policy = approvedProposedPolicy();

  it("excludes a post at the relevance exclude maximum", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.35, sentiment: "neutral", sentimentConfidence: 0.99, topicNouls: [] },
      policy,
    );
    expect(route.bucket).toBe("excluded");
    expect(route.relevance).toBe("irrelevant");
  });

  it("routes uncertain relevance below the include minimum to review", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.5, sentiment: "neutral", sentimentConfidence: 0.99, topicNouls: [] },
      policy,
    );
    expect(route.bucket).toBe("not_sure");
  });

  it("marks Belum yakin when sentiment confidence is below the proposed minimum", () => {
    const route = routeJudgment(
      {
        relevanceNoul: 0.9,
        sentiment: "negative",
        sentimentConfidence: 0.69,
        topicNouls: [{ id: "harga", noul: 0.9 }],
      },
      policy,
    );
    expect(route.sentimentUncertain).toBe(true);
    expect(route.bucket).toBe("not_sure");
  });

  it("assigns the lainnya fallback when topic noul is below the minimum", () => {
    const route = routeJudgment(
      {
        relevanceNoul: 0.9,
        sentiment: "positive",
        sentimentConfidence: 0.9,
        topicNouls: [{ id: "harga", noul: 0.64 }],
      },
      policy,
    );
    expect(route.topics).toEqual(["lainnya"]);
    expect(route.topicSource).toBe("fallback");
  });

  it("keeps a topic at the proposed noul minimum", () => {
    const route = routeJudgment(
      {
        relevanceNoul: 0.9,
        sentiment: "positive",
        sentimentConfidence: 0.9,
        topicNouls: [{ id: "harga", noul: 0.65 }],
      },
      policy,
    );
    expect(route.topics).toEqual(["harga"]);
    expect(route.topicSource).toBe("thresholds");
  });
});

describe("proposed attention threshold", () => {
  it("uses attentionNegativeConfidenceMin 0.85 for Perlu perhatian", () => {
    const policy = approvedProposedPolicy();
    expect(policy.attentionNegativeConfidenceMin).toBe(0.85);

    const includedNegative = routeJudgment(
      {
        relevanceNoul: 0.9,
        sentiment: "negative",
        sentimentConfidence: 0.85,
        topicNouls: [{ id: "harga", noul: 0.65 }],
      },
      policy,
    );

    expect(
      attentionDecision({ mentionId: "m1", route: includedNegative, sentimentConfidence: 0.84 }, policy),
    ).toEqual({ eligible: false, route: "none" });
    expect(
      attentionDecision({ mentionId: "m1", route: includedNegative, sentimentConfidence: 0.85 }, policy),
    ).toEqual({ eligible: true, reason: "negative" });
  });
});
