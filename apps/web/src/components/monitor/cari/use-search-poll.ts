"use client";

import { useCallback, useEffect, useState } from "react";
import type { SearchSnapshot } from "@/monitor/search/load";

const FINISHED = new Set(["succeeded", "partial", "failed"]);

export function useSearchPoll(
  searchId: string,
  initialSnapshot: SearchSnapshot,
  options: { intervalMs?: number } = {},
): {
  snapshot: SearchSnapshot;
  stale: boolean;
  refresh: () => void;
} {
  const intervalMs = options.intervalMs ?? 1000;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [requested, setRequested] = useState(0);
  const [received, setReceived] = useState(0);
  const refresh = useCallback(() => setRequested((count) => count + 1), []);
  const refreshing = requested !== received;
  const [stale, setStale] = useState(false);
  const [previousInitial, setPreviousInitial] = useState(initialSnapshot);
  if (previousInitial !== initialSnapshot) {
    setPreviousInitial(initialSnapshot);
    setSnapshot(initialSnapshot);
    setStale(false);
  }
  const questionOpen = snapshot.questions.some(
    (question) => question.status === "queued" || question.status === "running",
  );
  const moreOpen = snapshot.sources.some((source) => source.more?.state === "pending");
  const finished = FINISHED.has(snapshot.search.status) &&
    snapshot.search.summaryStatus !== "running" && !questionOpen && !moreOpen;

  useEffect(() => {
    if (finished && !refreshing) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/cari/${encodeURIComponent(searchId)}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("poll_failed");
        const next = (await response.json()) as SearchSnapshot;
        if (!cancelled) {
          setSnapshot(next);
          setReceived(requested);
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        inFlight = false;
      }
    };
    if (refreshing) void tick();
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [searchId, intervalMs, finished, refreshing, requested]);

  return { snapshot, stale, refresh };
}
