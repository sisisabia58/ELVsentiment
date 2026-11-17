"use client";

import { useEffect, useState } from "react";
import type { SearchSnapshot } from "@/monitor/search/load";

const FINISHED = new Set(["succeeded", "partial", "failed"]);

export function useSearchPoll(
  searchId: string,
  initialSnapshot: SearchSnapshot,
  options: { intervalMs?: number } = {},
): { snapshot: SearchSnapshot; stale: boolean } {
  const intervalMs = options.intervalMs ?? 1000;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [stale, setStale] = useState(false);
  const [previousInitial, setPreviousInitial] = useState(initialSnapshot);
  if (previousInitial !== initialSnapshot) {
    setPreviousInitial(initialSnapshot);
    setSnapshot(initialSnapshot);
    setStale(false);
  }
  const finished = FINISHED.has(snapshot.search.status) && snapshot.search.summaryStatus !== "running";

  useEffect(() => {
    if (finished) return;
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
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [searchId, intervalMs, finished]);

  return { snapshot, stale };
}
