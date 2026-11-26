import { expect, it } from "vitest";
import { readMonitorPolicy } from "./policy";
import { isOpenUncertain, presentMention, type StoredMention } from "./present";

const row: StoredMention = {
  id: "post", source: "threads", excerpt: "Tukuliling dingin", url: null, author: null,
  postedAt: "2026-01-01T00:00:00Z", collectedAt: "2026-01-01T00:00:00Z", scoringStatus: "pending",
  sourcePostUnavailable: false, readAt: null, relevanceNoul: null, sentiment: null, sentimentConfidence: null,
  topicNouls: [], correction: null, correctionAt: null, attentionId: null, attentionUnread: false,
  associationStatuses: [], triage: { status: "pending", judgment: null },
};
const routedAt = "2026-11-26T00:00:00Z";
function present(extra: Partial<StoredMention>) {
  return presentMention({ ...row, ...extra }, readMonitorPolicy().scoring);
}

it("keeps the manual queue and original date while a worker completes its judgment", () => {
  const manualRoute = { destination: "attention", routedAt } as const;
  expect(present({ manualRoute })).toMatchObject({ manualRoute, needsAttention: true, attentionUnread: true, scoringStatus: "pending" });
  const judgment = { destination: "mention", origin: "opencode", relevanceTier: "literal_match",
    sentiment: "mixed", reason: "non_actionable", issueCategory: null, verifiedExcerpt: "dingin" } as const;
  expect(present({ manualRoute, triage: { status: "completed", judgment }, readAt: routedAt }))
    .toMatchObject({ manualRoute, occurredAt: row.postedAt, bucket: "included", needsAttention: true,
      attentionUnread: false, sentiment: "mixed", triage: judgment });
});

it("counts manual ambiguity even after a relevant correction, and honors an irrelevant correction", () => {
  const manualRoute = { destination: "ambiguous", routedAt } as const;
  const correction = { action: "correct", relevance: "relevant", sentiment: "neutral", topics: [] } as const;
  const open = present({ manualRoute, correction: { ...correction, topics: [] } });
  expect(open).toMatchObject({ bucket: "not_sure", needsAttention: false, manualRoute });
  expect(isOpenUncertain(open)).toBe(true);
  expect(isOpenUncertain({ ...open, manualRoute: undefined })).toBe(false);
  const excluded = present({ manualRoute, correction: { ...correction, relevance: "irrelevant", topics: [] } });
  expect(excluded.bucket).toBe("excluded");
  expect(excluded.manualRoute).toBeUndefined();
});
