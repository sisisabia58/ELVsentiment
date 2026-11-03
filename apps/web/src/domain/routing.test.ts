import { describe, expect, it } from "vitest";
import { failedScoring, routeJudgment, suggestedLabels, type ScoringPolicy } from "./routing";

const policy: ScoringPolicy = {
  approved: true,
  relevanceExcludeMax: 0.2,
  relevanceIncludeMin: 0.8,
  sentimentConfidenceMin: 0.75,
  topicNoulMin: 0.7,
  attentionNegativeConfidenceMin: 0.8,
  fallbackTopicId: null,
};

describe("routeJudgment", () => {
  it("excludes a confidently irrelevant post", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.05, sentiment: "negative", sentimentConfidence: 0.99, topicNouls: [] },
      policy,
    );
    expect(route.bucket).toBe("excluded");
    expect(route.relevance).toBe("irrelevant");
    expect(route.sentiment).toBeNull();
  });

  it("routes an uncertain relevance score to review", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.5, sentiment: "neutral", sentimentConfidence: 0.99, topicNouls: [] },
      policy,
    );
    expect(route.bucket).toBe("not_sure");
    expect(route.relevance).toBe("uncertain");
  });

  it("holds a relevant post with a low sentiment confidence", () => {
    const route = routeJudgment(
      {
        relevanceNoul: 0.91,
        sentiment: "negative",
        sentimentConfidence: 0.4,
        topicNouls: [{ id: "harga", noul: 0.9 }],
      },
      policy,
    );
    expect(route.bucket).toBe("not_sure");
    expect(route.sentimentUncertain).toBe(true);
  });

  it("includes a relevant post when sentiment and topics clear the fixture thresholds", () => {
    const route = routeJudgment(
      {
        relevanceNoul: 0.95,
        sentiment: "positive",
        sentimentConfidence: 0.9,
        topicNouls: [{ id: "harga", noul: 0.91 }, { id: "rasa", noul: 0.2 }],
      },
      policy,
    );
    expect(route.bucket).toBe("included");
    expect(route.sentiment).toBe("positive");
    expect(route.topics).toEqual(["harga"]);
  });

  it("does not treat an unapproved policy as a final score", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.99, sentiment: "positive", sentimentConfidence: 0.99, topicNouls: [] },
      { ...policy, approved: false },
    );
    expect(route.bucket).toBe("policy_unapproved");
  });
});

describe("failedScoring", () => {
  it("has no sentiment label", () => {
    expect(failedScoring()).toEqual({ bucket: "failed", sentiment: null, topics: [] });
  });
});

describe("suggestedLabels", () => {
  it("offers no sentiment suggestion when confidence is below the fixture minimum", () => {
    const suggestion = suggestedLabels(
      { relevanceNoul: 0.95, sentiment: "negative", sentimentConfidence: 0.4, topicNouls: [] },
      policy,
    );
    expect(suggestion.sentiment).toBeNull();
  });
});
