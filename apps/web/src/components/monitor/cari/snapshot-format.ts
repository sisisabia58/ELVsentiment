import type { SearchSnapshot } from "@/monitor/search/load";

// Only credits the ledger actually recorded are shown. A failed search that
// never called a provider has no known cost, so it shows no credit figure.
export function knownCredits(snapshot: SearchSnapshot): number | null {
  const known = snapshot.sources.flatMap((source) =>
    typeof source.creditsCharged === "number" ? [source.creditsCharged] : [],
  );
  if (known.length === 0) return null;
  const total = known.reduce((sum, value) => sum + value, 0);
  return total > 0 ? total : null;
}

// A finished search must use started_at and finished_at. If either is missing
// (it never started, or a failed sweep stamped only finished_at), hide the
// elapsed time instead of showing a made-up "300 dtk".
export function elapsedSeconds(snapshot: SearchSnapshot, now: Date | null): number | null {
  const start = snapshot.search.startedAt;
  const end = snapshot.search.finishedAt ?? now?.toISOString() ?? null;
  if (!start || !end) return null;
  const value = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}
