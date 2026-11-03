import { overviewScore } from "../domain/aggregates";
import { describeChange, type ChangeTone } from "./format";
import type { PresentedMention, Sentiment } from "./present";
import { inWindow, rangeWindow, type RangeKey, type RangeWindow } from "./range";

export type SourceKey = "all" | "x" | "threads";

export type ChartPoint = {
  date: string;
  label: string;
  positif: number | null;
  netral: number | null;
  negatif: number | null;
  total: number | null;
  score: number | null;
  attention: number | null;
};

export type DashboardModel = {
  range: RangeKey;
  window: RangeWindow;
  periodLabel: string;
  score: { kind: "empty" } | { kind: "score"; value: number; included: number };
  totals: { positif: number; netral: number; negatif: number; total: number };
  attentionUnread: number;
  uncertainOpen: number;
  attentionInRange: number;
  uncertainInRange: number;
  comparison: {
    score: number | null;
    mentions: number | null;
    attention: number | null;
    uncertain: number | null;
  };
  points: ChartPoint[];
  gapLabels: string[];
  topics: { label: string; count: number }[];
  attentionItems: PresentedMention[];
  partial: boolean;
};

const SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function dayLabel(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(day)} ${SHORT[Number(month) - 1] ?? month}`;
}

function counts(mentions: readonly PresentedMention[]): { positif: number; netral: number; negatif: number; total: number } {
  const totals = { positif: 0, netral: 0, negatif: 0, total: 0 };
  for (const mention of mentions) {
    if (mention.bucket !== "included" || !mention.sentiment) continue;
    totals.total += 1;
    if (mention.sentiment === "positive") totals.positif += 1;
    else if (mention.sentiment === "negative") totals.negatif += 1;
    else totals.netral += 1;
  }
  return totals;
}

function scoreOf(totals: { positif: number; netral: number; negatif: number }): number | null {
  const score = overviewScore({ positive: totals.positif, negative: totals.negatif, neutral: totals.netral });
  if (score.kind === "empty") return null;
  return score.value;
}

function includedIn(mentions: readonly PresentedMention[], start: Date, end: Date, source: SourceKey): PresentedMention[] {
  return mentions.filter((mention) => {
    if (source !== "all" && mention.source !== source) return false;
    if (!mention.postedAt) return false;
    return inWindow(mention.postedAt, start, end);
  });
}

export function buildDashboard(input: {
  mentions: readonly PresentedMention[];
  range: RangeKey;
  source: SourceKey;
  now: Date;
  attentionUnread: number;
  uncertainOpen: number;
  partial: boolean;
}): DashboardModel {
  const window = rangeWindow(input.range, input.now);
  const current = includedIn(input.mentions, window.start, window.end, input.source);
  const previous = includedIn(input.mentions, window.previousStart, window.start, input.source);
  const currentIncluded = current.filter((mention) => mention.bucket === "included" && mention.sentiment);
  const previousIncluded = previous.filter((mention) => mention.bucket === "included" && mention.sentiment);
  const totals = counts(currentIncluded);
  const previousTotals = counts(previousIncluded);
  const currentScore = scoreOf(totals);
  const previousScore = scoreOf(previousTotals);
  const score =
    currentScore === null || totals.total === 0
      ? ({ kind: "empty" } as const)
      : ({ kind: "score", value: currentScore, included: totals.total } as const);

  const byDay = new Map<string, PresentedMention[]>();
  for (const mention of currentIncluded) {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(mention.postedAt ?? mention.collectedAt));
    const list = byDay.get(day) ?? [];
    list.push(mention);
    byDay.set(day, list);
  }

  const points: ChartPoint[] = window.days.map((date) => {
    const rows = byDay.get(date);
    if (!rows || rows.length === 0) {
      return {
        date,
        label: dayLabel(date),
        positif: null,
        netral: null,
        negatif: null,
        total: null,
        score: null,
        attention: null,
      };
    }
    const dayTotals = counts(rows);
    const attention = current.filter(
      (mention) =>
        mention.needsAttention &&
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Jakarta",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(mention.postedAt ?? mention.collectedAt)) === date,
    ).length;
    return {
      date,
      label: dayLabel(date),
      positif: dayTotals.positif,
      netral: dayTotals.netral,
      negatif: dayTotals.negatif,
      total: dayTotals.total,
      score: scoreOf(dayTotals),
      attention,
    };
  });

  const topicCounts = new Map<string, number>();
  for (const mention of currentIncluded) {
    for (const topic of mention.topics) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }
  const topics = [...topicCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "id"));

  const attentionItems = current
    .filter((mention) => mention.needsAttention)
    .sort((left, right) => (right.postedAt ?? "").localeCompare(left.postedAt ?? ""))
    .slice(0, 3);

  const previousAttention = previous.filter((mention) => mention.needsAttention).length;
  const currentAttention = current.filter((mention) => mention.needsAttention).length;
  const previousUncertain = previous.filter((mention) => mention.bucket === "not_sure").length;
  const currentUncertain = current.filter((mention) => mention.bucket === "not_sure").length;

  return {
    range: input.range,
    window,
    periodLabel: `${input.range} hari`,
    score,
    totals,
    attentionUnread: input.attentionUnread,
    uncertainOpen: input.uncertainOpen,
    attentionInRange: currentAttention,
    uncertainInRange: currentUncertain,
    comparison: {
      score: currentScore === null || previousScore === null ? null : Math.round(currentScore) - Math.round(previousScore),
      mentions: previousIncluded.length === 0 ? null : totals.total - previousTotals.total,
      attention: previous.length === 0 ? null : currentAttention - previousAttention,
      uncertain: previous.length === 0 ? null : currentUncertain - previousUncertain,
    },
    points,
    gapLabels: points.filter((point) => point.total === null).map((point) => point.label),
    topics,
    attentionItems,
    partial: input.partial,
  };
}

export function changeTone(change: number | null, higherIsBetter: boolean): ChangeTone {
  return describeChange(change, higherIsBetter).tone;
}

export function sentimentKey(sentiment: Sentiment): "positif" | "netral" | "negatif" {
  if (sentiment === "positive") return "positif";
  if (sentiment === "negative") return "negatif";
  return "netral";
}
