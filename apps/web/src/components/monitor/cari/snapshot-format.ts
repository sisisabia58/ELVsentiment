import type { SearchSnapshot } from "@/monitor/search/load";

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
