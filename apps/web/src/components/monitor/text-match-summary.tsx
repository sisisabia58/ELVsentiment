import { formatNumber } from "@/monitor/format";
import type { TextMatchCounts } from "@/monitor/relevance";

export function TextMatchSummary(props: { counts: TextMatchCounts }) {
  return (
    <>
      <p className="tabular-nums">
        Kandidat {formatNumber(props.counts.candidates)} · Cocok teks {formatNumber(props.counts.literal)} · Belum pasti{" "}
        {formatNumber(props.counts.unknown)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Pencocokan teks, bukan verifikasi makna.</p>
    </>
  );
}
