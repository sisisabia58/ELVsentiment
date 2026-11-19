"use client";

import { useState } from "react";
import type { SnapshotAi, SnapshotComment, SnapshotResult } from "@/monitor/search/load";
import { EvidenceLinks } from "./evidence-links";
import { PlatformTile, platformName } from "./platform-tile";
import { evidenceSources, isStance, resolveEvidence, supportedPlatforms } from "./quote-source";
import { StanceChip } from "./stance-chip";

export function AiSummary(props: {
  ai: SnapshotAi | null;
  summaryStatus?: string;
  results?: SnapshotResult[];
  comments?: SnapshotComment[];
}) {
  const [expanded, setExpanded] = useState(false);
  const status = props.summaryStatus ?? (props.ai ? "done" : "pending");
  if (status === "skipped") return null;

  const ai = props.ai;
  const sample = evidenceSources(ai?.evidenceIds, props.results ?? [], props.comments ?? []);
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
  const extra = Math.max(0, platforms.length - 3);
  const postCount = [...sample.values()].filter((source) => source.kind === "post").length;
  return (
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card">
      <h2 className="text-[15px] font-semibold text-foreground">Ringkasan AI</h2>
      <p className="mt-2 text-[13.5px] leading-6 text-foreground">{ai.overallSummary}</p>
      <EvidenceLinks sources={sources} label="Sumber ringkasan" />
      <p className="mt-2 text-[12px] text-muted-foreground">
        Cuplikan AI · {postCount} unggahan dan {sample.size - postCount} balasan
      </p>
      {isStance(ai.overallStance) ? (
        <div className="mt-3"><StanceChip stance={ai.overallStance} /></div>
      ) : null}
      {platforms.length ? (
        <ul className="mt-3 space-y-3">
          {platforms.map((item, index) => (
            <li key={item.platform} className={index >= 3 && !expanded ? "hidden lg:block" : ""}>
              <div className="flex items-center gap-2">
                <PlatformTile platform={item.platform} size={18} />
                <span className="text-[13px] font-semibold text-foreground">{platformName(item.platform)}</span>
                <StanceChip stance={item.stance} />
              </div>
              <p className="mt-1 text-[13px] leading-5 text-foreground">{item.summary}</p>
              <EvidenceLinks sources={item.sources} label={`Sumber ${platformName(item.platform)}`} />
            </li>
          ))}
        </ul>
      ) : null}
      {extra > 0 && !expanded ? (
        <button type="button" className="mt-2 text-[12.5px] font-medium text-primary lg:hidden" onClick={() => setExpanded(true)}>
          Lihat {extra} platform lainnya
        </button>
      ) : null}
    </section>
  );
}
