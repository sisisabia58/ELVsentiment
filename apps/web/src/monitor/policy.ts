import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoringPolicy } from "../domain/routing";
import type { SourceId } from "./sources";

export { ALL_SOURCES, SOURCE_NAME, type SourceId } from "./sources";

export const PROPOSED_RELEVANCE_EXCLUDE_MAX = 0.35;
export const PROPOSED_RELEVANCE_INCLUDE_MIN = 0.75;
export const PROPOSED_SENTIMENT_CONFIDENCE_MIN = 0.7;
export const PROPOSED_TOPIC_NOUL_MIN = 0.65;
export const PROPOSED_ATTENTION_NEGATIVE_CONFIDENCE_MIN = 0.85;

type LaunchApprovals = {
  scoring_policy?: boolean;
  topic_labels?: boolean;
  topic_counting?: boolean;
  high_impact?: boolean;
};

type TopicLabelRow = { id?: string; label?: string; instructions?: string };

type TopicFile = { approved?: boolean; fallbackId?: string | null; labels?: TopicLabelRow[] };

function readJson<T>(name: string): T {
  const configDir = process.env.CONFIG_DIR?.trim();
  const file = configDir
    ? path.join(configDir, name)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../config", name);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function topicLabelsFromFile(labels: TopicLabelRow[] | undefined): { id: string; label: string }[] {
  if (!Array.isArray(labels)) return [];
  const mapped: { id: string; label: string }[] = [];
  for (const row of labels) {
    const id = row.id?.trim();
    if (!id) continue;
    mapped.push({ id, label: row.label?.trim() || id });
  }
  return mapped;
}

function topicQuestionsFromFile(
  labels: TopicLabelRow[] | undefined,
  fallbackId: string | null,
): { id: string; instructions: string }[] {
  if (!Array.isArray(labels)) return [];
  const questions: { id: string; instructions: string }[] = [];
  for (const row of labels) {
    const id = row.id?.trim();
    if (!id || id === fallbackId) continue;
    const instructions = row.instructions?.trim();
    if (!instructions) continue;
    questions.push({ id, instructions });
  }
  return questions;
}

export function readMonitorPolicy(): {
  scoring: ScoringPolicy;
  topicLabels: { id: string; label: string }[];
  topicQuestions: { id: string; instructions: string }[];
  topicCountingApproved: boolean;
  highImpact: boolean;
} {
  const approvals = readJson<LaunchApprovals>("launch-approvals.json");
  const topics = readJson<TopicFile>("topic-labels.json");
  const fallbackTopicId = topics.fallbackId ?? null;
  const approved = approvals.scoring_policy === true && approvals.topic_labels === true && topics.approved === true;
  return {
    scoring: {
      approved,
      relevanceExcludeMax: PROPOSED_RELEVANCE_EXCLUDE_MAX,
      relevanceIncludeMin: PROPOSED_RELEVANCE_INCLUDE_MIN,
      sentimentConfidenceMin: PROPOSED_SENTIMENT_CONFIDENCE_MIN,
      topicNoulMin: PROPOSED_TOPIC_NOUL_MIN,
      attentionNegativeConfidenceMin: PROPOSED_ATTENTION_NEGATIVE_CONFIDENCE_MIN,
      fallbackTopicId,
    },
    topicLabels: topicLabelsFromFile(topics.labels),
    topicQuestions: topicQuestionsFromFile(topics.labels, fallbackTopicId),
    topicCountingApproved: approvals.topic_counting === true,
    highImpact: approvals.high_impact === true,
  };
}

export function reviewTopicChoices(
  policy: ReturnType<typeof readMonitorPolicy> = readMonitorPolicy(),
): { id: string; label: string }[] {
  const fallback = policy.scoring.fallbackTopicId;
  if (!fallback || policy.topicLabels.some((topic) => topic.id === fallback)) return policy.topicLabels;
  return [...policy.topicLabels, { id: fallback, label: "Lainnya" }];
}

export function sourceCredentials(
  env: Record<string, string | undefined> = process.env,
): Record<SourceId, boolean> {
  const sc = Boolean(env.SCRAPECREATORS_API_KEY?.trim() || env.THREADS_ACCESS_TOKEN?.trim());
  const scOnly = Boolean(env.SCRAPECREATORS_API_KEY?.trim());
  return {
    x: Boolean(env.X_BEARER_TOKEN?.trim()),
    threads: sc,
    instagram: scOnly,
    tiktok: scOnly,
  };
}
