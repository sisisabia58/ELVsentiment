"use client";

import { useState } from "react";
import type { SnapshotAi, SnapshotComment, SnapshotResult } from "@/monitor/search/load";
import { PlatformTile, platformName } from "./platform-tile";
import { quoteHref } from "./quote-source";
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

function summaryParagraphs(text: string): string[] {
  const blocks = text
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return blocks.length > 0 ? blocks : [text];
}

function majorityFromCounts(
  platforms: PlatformSummary[],
  counts: Record<string, number> | undefined,
): { stance: string; percent: number } | null {
  if (!counts) return null;
  const totals = new Map<string, number>();
  for (const item of platforms) {
    if (!item.platform || !item.stance || !(item.stance in STANCE_LABEL)) continue;
    const count = counts[item.platform] ?? 0;
    if (count <= 0) continue;
    totals.set(item.stance, (totals.get(item.stance) ?? 0) + count);
  }
  const classified = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (classified <= 0) return null;
  const [stance, count] = [...totals.entries()].sort((left, right) => right[1] - left[1])[0];
  return { stance, percent: Math.round((count / classified) * 100) };
}

function uniqueQuotes(quotes: Quote[]): Quote[] {
  const seen = new Set<string>();
  return quotes.filter((quote) => {
    const key = (quote.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function QuoteText(props: { text: string; href: string | null }) {
  if (!props.href) return <span>{props.text}</span>;
  const external = props.href.startsWith("http");
  return (
    <a href={props.href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {props.text}
    </a>
  );
}

export function AiSummary(props: {
  ai: SnapshotAi | null;
  summaryStatus?: string;
  resultCount?: number;
  commentCount?: number;
  platformCounts?: Record<string, number>;
  results?: Pick<SnapshotResult, "id" | "url">[];
  comments?: Pick<SnapshotComment, "id" | "resultId">[];
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
  const quotes = uniqueQuotes(asList<Quote>(ai.quotes).filter((item) => item.text));
  const themes = asList<Theme>(ai.themes).filter((item) => item.title);
  const extra = Math.max(0, platforms.length - 3);
  const majority = majorityFromCounts(platforms, props.platformCounts);
  const modelLabel = ai.overallStance ? (STANCE_LABEL[ai.overallStance] ?? ai.overallStance) : null;
  return (
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card">
      <h2 className="text-[15px] font-semibold text-foreground">Ringkasan AI</h2>
      <div className="mt-2 space-y-3">
        {summaryParagraphs(ai.overallSummary).map((paragraph, index) => (
          <p key={index} className="text-[13.5px] leading-6 text-foreground">
            {paragraph}
          </p>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-muted-foreground">
        Ditulis AI dari {props.resultCount ?? 0} hasil dan {props.commentCount ?? 0} komentar teratas · bisa keliru, cek kutipannya
      </p>
      {majority ? (
        <p className="mt-3 text-[13px] text-foreground">
          <span className="font-semibold">
            {STANCE_LABEL[majority.stance]} {majority.percent}%
          </span>
          {modelLabel && ai.overallStance !== majority.stance ? (
            <span className="ml-2 text-[12px] text-muted-foreground">
              Model menandai {modelLabel}. Angka ini dihitung dari jumlah hasil per platform.
            </span>
          ) : null}
        </p>
      ) : ai.overallStance ? (
        <div className="mt-3">
          <StanceChip stance={ai.overallStance} />
          <span className="sr-only">{modelLabel}</span>
        </div>
      ) : null}
      <ul className="mt-3 space-y-3">
        {platforms.map((item, index) => (
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
            </li>
          ))}
      </ul>
      {extra > 0 && !expanded ? (
        <button type="button" className="mt-2 text-[12.5px] font-medium text-primary lg:hidden" onClick={() => setExpanded(true)}>
          Lihat {extra} platform lainnya
        </button>
      ) : null}
      {quotes.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {quotes.map((quote) => (
            <li key={`${quote.ref_id ?? ""}:${quote.text}`} className="border-l-2 border-border pl-2 text-[12.5px] text-muted-foreground">
              <QuoteText
                text={quote.text ?? ""}
                href={quoteHref(quote.ref_id, props.results ?? [], props.comments ?? [])}
              />
              {quote.author ? <span className="ml-1 font-mono">{quote.author}</span> : null}
            </li>
          ))}
        </ul>
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
