import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMonitorPolicy } from "./policy";

const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../..");

const PROPOSED_NUMBERS = {
  relevanceExcludeMax: 0.35,
  relevanceIncludeMin: 0.75,
  sentimentConfidenceMin: 0.7,
  topicNoulMin: 0.65,
  attentionNegativeConfidenceMin: 0.85,
};

describe("approved scoring and Threads settings", () => {
  it("sets launch approval flags for scoring, topics, counting, and credentials", () => {
    const launch = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/launch-approvals.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(launch.scoring_policy).toBe(true);
    expect(launch.topic_labels).toBe(true);
    expect(launch.topic_counting).toBe(true);
    expect(launch.credential_policy).toBe(true);
    expect(launch.high_impact).toBe(false);
    expect(launch.jev_fallback_rule).toBe(false);
    expect(launch.reduced_source_launch).toBe(null);
  });

  it("approves credential-policy with shared_operator mode", () => {
    const credentialPolicy = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/credential-policy.json"), "utf8"),
    );
    expect(credentialPolicy).toEqual({ approved: true, mode: "shared_operator" });
  });

  it("keeps x-budget unapproved", () => {
    const xBudget = JSON.parse(readFileSync(path.join(REPO_ROOT, "config/x-budget.json"), "utf8"));
    expect(xBudget).toEqual({ approved: false });
  });

  it("approves topic-labels with lainnya fallback", () => {
    const topicLabels = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/topic-labels.json"), "utf8"),
    ) as { approved?: boolean; fallbackId?: string };
    expect(topicLabels.approved).toBe(true);
    expect(topicLabels.fallbackId).toBe("lainnya");
  });

  it("readMonitorPolicy reports approved scoring with unchanged thresholds", () => {
    const policy = readMonitorPolicy();
    expect(policy.scoring.approved).toBe(true);
    expect(policy.scoring.relevanceExcludeMax).toBe(PROPOSED_NUMBERS.relevanceExcludeMax);
    expect(policy.scoring.relevanceIncludeMin).toBe(PROPOSED_NUMBERS.relevanceIncludeMin);
    expect(policy.scoring.sentimentConfidenceMin).toBe(PROPOSED_NUMBERS.sentimentConfidenceMin);
    expect(policy.scoring.topicNoulMin).toBe(PROPOSED_NUMBERS.topicNoulMin);
    expect(policy.scoring.attentionNegativeConfidenceMin).toBe(
      PROPOSED_NUMBERS.attentionNegativeConfidenceMin,
    );
    expect(policy.topicCountingApproved).toBe(true);
    expect(policy.highImpact).toBe(false);
  });
});
