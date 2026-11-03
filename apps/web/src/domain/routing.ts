export type ScoringPolicy = {
  approved: boolean;
  relevanceExcludeMax: number | null;
  relevanceIncludeMin: number | null;
  sentimentConfidenceMin: number | null;
  topicNoulMin: number | null;
  attentionNegativeConfidenceMin: number | null;
  fallbackTopicId: string | null;
};

export type ParsedJudgment = {
  relevanceNoul: number;
  sentiment: "positive" | "neutral" | "negative";
  sentimentConfidence: number;
  topicNouls: { id: string; noul: number }[];
};

export type RouteDecision = {
  bucket: "included" | "excluded" | "not_sure" | "policy_unapproved";
  relevance: "relevant" | "irrelevant" | "uncertain" | "unapproved";
  sentiment: "positive" | "neutral" | "negative" | null;
  sentimentUncertain: boolean;
  topics: string[];
  topicsUncertain: boolean;
  topicSource: "thresholds" | "fallback" | "none";
};

export type FailedScoring = { bucket: "failed"; sentiment: null; topics: readonly [] };

export type SuggestedLabels = {
  relevance: "relevant" | "irrelevant" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
};

function requireApprovedNumbers(policy: ScoringPolicy): {
  relevanceExcludeMax: number;
  relevanceIncludeMin: number;
  sentimentConfidenceMin: number;
  topicNoulMin: number;
} {
  const { relevanceExcludeMax, relevanceIncludeMin, sentimentConfidenceMin, topicNoulMin } = policy;
  if (
    relevanceExcludeMax === null ||
    relevanceIncludeMin === null ||
    sentimentConfidenceMin === null ||
    topicNoulMin === null ||
    !(relevanceExcludeMax < relevanceIncludeMin)
  ) {
    throw new Error("policy_incomplete");
  }
  return { relevanceExcludeMax, relevanceIncludeMin, sentimentConfidenceMin, topicNoulMin };
}

export function failedScoring(): FailedScoring {
  return { bucket: "failed", sentiment: null, topics: [] };
}

export function routeJudgment(judgment: ParsedJudgment, policy: ScoringPolicy): RouteDecision {
  if (!policy.approved) {
    return {
      bucket: "policy_unapproved",
      relevance: "unapproved",
      sentiment: null,
      sentimentUncertain: false,
      topics: [],
      topicsUncertain: false,
      topicSource: "none",
    };
  }
  const numbers = requireApprovedNumbers(policy);
  const base: RouteDecision = {
    bucket: "not_sure",
    relevance: "uncertain",
    sentiment: null,
    sentimentUncertain: false,
    topics: [],
    topicsUncertain: false,
    topicSource: "none",
  };
  if (judgment.relevanceNoul <= numbers.relevanceExcludeMax) {
    return { ...base, bucket: "excluded", relevance: "irrelevant" };
  }
  if (judgment.relevanceNoul < numbers.relevanceIncludeMin) return base;
  base.relevance = "relevant";
  if (judgment.sentimentConfidence < numbers.sentimentConfidenceMin) {
    return { ...base, sentiment: judgment.sentiment, sentimentUncertain: true };
  }
  base.sentiment = judgment.sentiment;
  const topics = judgment.topicNouls
    .filter((topic) => topic.noul >= numbers.topicNoulMin)
    .map((topic) => topic.id);
  if (topics.length > 0) {
    return { ...base, bucket: "included", topics, topicSource: "thresholds" };
  }
  if (policy.fallbackTopicId) {
    return {
      ...base,
      bucket: "included",
      topics: [policy.fallbackTopicId],
      topicSource: "fallback",
    };
  }
  return { ...base, topicsUncertain: true };
}

export function suggestedLabels(judgment: ParsedJudgment, policy: ScoringPolicy): SuggestedLabels {
  if (!policy.approved) return { relevance: null, sentiment: null, topics: [] };
  const route = routeJudgment(judgment, policy);
  return {
    relevance:
      route.relevance === "relevant" || route.relevance === "irrelevant" ? route.relevance : null,
    sentiment: route.sentimentUncertain ? null : route.sentiment,
    topics: route.topicsUncertain ? [] : route.topics,
  };
}
