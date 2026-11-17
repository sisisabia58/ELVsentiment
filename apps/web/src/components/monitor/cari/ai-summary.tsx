"use client";

import { useState } from "react";
import type { SnapshotAi } from "@/monitor/search/load";
import { PlatformTile, platformName } from "./platform-tile";
import { StanceChip } from "./stance-chip";

const STANCE_LABEL: Record<string, string> = {
  positif: "Positif",
  campuran: "Campuran",
  negatif: "Negatif",
  netral: "Netral",
  faktual: "Faktual",
};

type PlatformSummary = {
  platform?: string;
  stance?: string;
  summary?: string;
  quote_id?: string | null;
};

type Quote = {
  type?: string;
  text?: string;
  ref_id?: string;
  platform?: string;
  author?: string;
};

type Theme = {
  title?: string;
  description?: string;
};

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function AiSummary(props: {
  ai: SnapshotAi | null;
  summaryStatus?: string;
  resultCount?: number;
  commentCount?: number;
  platformCounts?: Record<string, number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = props.summaryStatus ?? (props.ai ? "done" : "pending");
  if (status === "skipped") return null;
  if (status === "running" || status === "pending") {
    return (
      <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card" aria-busy="true">
        <h2 className="text-[15px] font-semibold text-foreground">Ringkasan AI</h2>
        <p className="mt-2 text-[13px] text-muted-foreground">Ringkasan ditulis setelah komentar terkumpul.</p>
      </section>
    );
  }
  if (!props.ai || status === "failed") {
    return (
      <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card">
        <h2 className="text-[15px] font-semibold text-foreground">Ringkasan AI</h2>
        <p className="mt-2 text-[13px] text-muted-foreground">Ringkasan belum tersedia. Hasil pencarian tetap ditampilkan.</p>
      </section>
    );
  }
  const ai = props.ai;
  const platforms = asList<PlatformSummary>(ai.platformSummaries).filter(
    (item) => item.platform && item.summary,
  );
  const quotes = asList<Quote>(ai.quotes).filter((item) => item.text);
  const themes = asList<Theme>(ai.themes).filter((item) => item.title);
  const extra = Math.max(0, platforms.length - 3);
  return (
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card">
      <h2 className="text-[15px] font-semibold text-foreground">Ringkasan AI</h2>
      <p className="mt-2 text-[13.5px] leading-6 text-foreground">{ai.overallSummary}</p>
      <p className="mt-2 text-[12px] text-muted-foreground">
        Ditulis AI dari {props.resultCount ?? 0} hasil dan {props.commentCount ?? 0} komentar teratas · bisa keliru, cek kutipannya
      </p>
      {ai.overallStance ? (
        <div className="mt-3">
          <StanceChip stance={ai.overallStance} />
          <span className="sr-only">{STANCE_LABEL[ai.overallStance] ?? ai.overallStance}</span>
        </div>
      ) : null}
      <ul className="mt-3 space-y-3">
        {platforms.map((item, index) => {
          const quote =
            quotes.find((candidate) => candidate.ref_id && candidate.ref_id === item.quote_id) ??
            quotes.find((candidate) => candidate.platform === item.platform);
          return (
            <li key={`${item.platform}-${index}`} className={index >= 3 && !expanded ? "hidden lg:block" : ""}>
              <div className="flex items-center gap-2">
                <PlatformTile platform={item.platform ?? "web"} size={18} />
                <span className="text-[13px] font-semibold text-foreground">{platformName(item.platform ?? "")}</span>
                {item.stance ? <StanceChip stance={item.stance} /> : null}
                {props.platformCounts && item.platform ? (
                  <span className="text-[12px] text-muted-foreground">{props.platformCounts[item.platform] ?? 0}</span>
                ) : null}
              </div>
              <p className="mt-1 text-[13px] leading-5 text-foreground">{item.summary}</p>
              {quote?.text ? (
                <blockquote className="mt-1 border-l-2 border-border pl-2 text-[12.5px] text-muted-foreground">
                  <span>{quote.text}</span>
                  {quote.author ? <span className="ml-1 font-mono">{quote.author}</span> : null}
                </blockquote>
              ) : null}
            </li>
          );
        })}
      </ul>
      {extra > 0 && !expanded ? (
        <button type="button" className="mt-2 text-[12.5px] font-medium text-primary lg:hidden" onClick={() => setExpanded(true)}>
          Lihat {extra} platform lainnya
        </button>
      ) : null}
      {themes.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {themes.map((theme) => (
            <li key={theme.title} className="text-[13px] font-medium text-foreground">
              {theme.title}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
