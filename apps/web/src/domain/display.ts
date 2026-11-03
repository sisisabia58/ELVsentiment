import type { FailedScoring, RouteDecision } from "./routing";

export type OwnerCorrection = {
  action: "confirm" | "correct";
  relevance: "relevant" | "irrelevant";
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
};

export type DisplayState = {
  bucket: "included" | "excluded" | "not_sure" | "failed" | "policy_unapproved";
  relevance: "relevant" | "irrelevant" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
  source: "jev" | "owner_confirm" | "owner_correct" | "failed";
};

export function displayOf(route: RouteDecision | FailedScoring, correction: OwnerCorrection | null): DisplayState {
  if (correction) {
    return {
      bucket: correction.relevance === "relevant" ? "included" : "excluded",
      relevance: correction.relevance,
      sentiment: correction.relevance === "relevant" ? correction.sentiment : null,
      topics: correction.relevance === "relevant" ? correction.topics : [],
      source: correction.action === "confirm" ? "owner_confirm" : "owner_correct",
    };
  }
  if (route.bucket === "failed") {
    return { bucket: "failed", relevance: null, sentiment: null, topics: [], source: "failed" };
  }
  return {
    bucket: route.bucket,
    relevance: route.relevance === "relevant" || route.relevance === "irrelevant" ? route.relevance : null,
    sentiment: route.sentiment,
    topics: route.topics,
    source: "jev",
  };
}
