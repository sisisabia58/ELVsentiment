export type SentimentCounts = { positive: number; negative: number; neutral: number };
export type OverviewScore = { kind: "empty" } | { kind: "score"; value: number; included: number };
export type TrendRow = { createdAt: Date; sentiment: "positive" | "neutral" | "negative" };
export type TrendBucket = { bucketStart: string; positive: number; neutral: number; negative: number };

export function overviewScore(counts: SentimentCounts): OverviewScore {
  const included = counts.positive + counts.negative + counts.neutral;
  if (included === 0) return { kind: "empty" };
  return { kind: "score", value: (100 * (counts.positive - counts.negative)) / included, included };
}

function civilDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function mondayOf(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay();
  const offset = weekday === 0 ? 6 : weekday - 1;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}

export function trendTable(rows: readonly TrendRow[], bucket: "day" | "week", timeZone: string): TrendBucket[] {
  const groups = new Map<string, TrendBucket>();
  for (const row of rows) {
    const day = civilDate(row.createdAt, timeZone);
    const bucketStart = bucket === "week" ? mondayOf(day) : day;
    const current = groups.get(bucketStart) ?? { bucketStart, positive: 0, neutral: 0, negative: 0 };
    current[row.sentiment] += 1;
    groups.set(bucketStart, current);
  }
  return [...groups.values()].sort((left, right) => left.bucketStart.localeCompare(right.bucketStart));
}

export function topicCounts(rows: readonly { topics: readonly string[] }[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const label of row.topics) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}
