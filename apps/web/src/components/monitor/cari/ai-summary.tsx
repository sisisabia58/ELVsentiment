"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import type { SnapshotAi, SnapshotComment, SnapshotResult } from "@/monitor/search/load";
import { EvidenceLinks } from "./evidence-links";
import { ConversationBreakdown } from "./conversation-breakdown";
import { evidenceSources, isStance, resolveEvidence, supportedPlatforms, supportedQuotes, supportedThemes } from "./quote-source";
import { StanceChip } from "./stance-chip";

export function AiSummary(props: {
  ai: SnapshotAi | null;
  summaryStatus?: string;
  results?: SnapshotResult[];
  comments?: SnapshotComment[];
  hasMoreResults?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const status = props.summaryStatus ?? (props.ai ? "done" : "pending");
  if (status === "skipped") return null;

  const ai = props.ai;
  const results = props.results ?? [];
  const sample = evidenceSources(ai?.evidenceIds, results, props.comments ?? []);
  const sources = resolveEvidence(ai?.overallSupportingIds, sample);
  const waiting = status === "pending" || status === "running";
  const message = waiting
    ? "Ringkasan ditulis setelah komentar terkumpul."
    : status === "insufficient"
      ? "Belum cukup bukti yang relevan untuk membuat ringkasan."
      : "Ringkasan belum tersedia. Hasil pencarian tetap ditampilkan.";
  if (status !== "done" || !ai?.overallSummary.trim() || !sources.length) {
    return (
      <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card" aria-busy={waiting}>
        <h2 className="text-[15px] font-semibold text-foreground">Ringkasan AI</h2>
        <p className="mt-2 text-[13px] text-muted-foreground">{message}</p>
      </section>
    );
  }

  const platforms = supportedPlatforms(ai, sample);
  const quotes = supportedQuotes(ai, sample);
  const themes = supportedThemes(ai, sample);
  const postCount = [...sample.values()].filter((source) => source.kind === "post").length;
  return (
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card">
      <h2 className="text-[15px] font-semibold text-foreground">Ringkasan AI</h2>
      <p className="mt-2 text-base leading-6 wrap-anywhere text-foreground">{ai.overallSummary}</p>
      <EvidenceLinks sources={sources} label="Sumber ringkasan" />
      <p className="mt-2 text-[12px] text-muted-foreground">
        {props.hasMoreResults ? "Cuplikan AI dari pencarian awal" : "Cuplikan AI"} · {postCount} unggahan dan {sample.size - postCount} balasan
      </p>
      {isStance(ai.overallStance) ? (
        <div className="mt-3"><StanceChip stance={ai.overallStance} /></div>
      ) : null}
      {results.length || platforms.length || themes.length || quotes.length ? (
        <div className="mt-4 border-t border-border pt-2">
          <button
            type="button"
            aria-controls={detailsId}
            aria-expanded={expanded}
            className="workspace-feedback flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm font-semibold text-primary hover:bg-primary/5 lg:hidden"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Sembunyikan detail ringkasan" : "Lihat detail ringkasan"}
            <ChevronDown className={cn("size-4 shrink-0", expanded && "rotate-180")} aria-hidden="true" />
          </button>
          <div id={detailsId} className={cn(expanded ? "cari-reveal" : "hidden", "lg:block")}>
            <ConversationBreakdown results={results} platforms={platforms} quotes={quotes} themes={themes} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
