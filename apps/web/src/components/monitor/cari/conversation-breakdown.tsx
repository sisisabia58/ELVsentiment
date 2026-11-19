import type { SearchSnapshot } from "@/monitor/search/load";
import { EvidenceLinks } from "./evidence-links";
import { PlatformTile, platformName } from "./platform-tile";
import {
  evidenceSources, QUOTE_LABELS, resolveEvidence, sourceLabel, sourceLinkProps,
  supportedPlatforms, supportedQuotes, supportedThemes,
} from "./quote-source";
import { StanceChip } from "./stance-chip";

const SECTION_HEADING = "mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

export function ConversationBreakdown({ snapshot }: { snapshot: SearchSnapshot }) {
  const ai = snapshot.ai;
  if (!ai || snapshot.search.summaryStatus !== "done") return null;
  const sample = evidenceSources(ai.evidenceIds, snapshot.results, snapshot.comments);
  if (!resolveEvidence(ai.overallSupportingIds, sample).length) return null;
  const platforms = supportedPlatforms(ai, sample);
  const quotes = supportedQuotes(ai, sample);
  const themes = supportedThemes(ai, sample);
  const resultCounts = new Map<string, number>();
  for (const result of snapshot.results) {
    resultCounts.set(result.platform, (resultCounts.get(result.platform) ?? 0) + 1);
  }
  const maxCount = Math.max(1, ...resultCounts.values());

  return (
    <section className="mt-8 rounded-[14px] border border-border bg-surface p-5 shadow-card">
      <h2 className="text-[16px] font-semibold text-foreground">Bagaimana percakapannya</h2>
      <h3 className={SECTION_HEADING}>Hasil per platform</h3>
      <ul className="mt-2 space-y-2">
        {[...resultCounts.entries()].map(([platform, count]) => (
          <li key={platform} className="grid grid-cols-[120px_minmax(0,1fr)_32px] items-center gap-2 text-[13px]">
            <span className="flex items-center gap-2">
              <PlatformTile platform={platform} size={16} />
              {platformName(platform)}
            </span>
            <span className="h-2 overflow-hidden rounded-sm bg-surface-subtle">
              <span className="block h-full bg-primary" style={{ width: `${Math.round((count / maxCount) * 100)}%` }} />
            </span>
            <span className="text-right tabular-nums">{count}</span>
          </li>
        ))}
      </ul>
      {quotes.length > 0 ? (
        <>
          <h3 className={SECTION_HEADING}>Kutipan</h3>
          {QUOTE_LABELS.map(([type, label]) => {
            const group = quotes.filter((quote) => quote.type === type);
            return group.length ? (
              <div key={type} className="mt-3">
                <h4 className="text-[12px] font-semibold text-foreground">{label}</h4>
                <ul className="mt-1 space-y-2">
                  {group.map(({ text, source }) => (
                    <li key={text} className="border-l-2 border-border pl-2 text-[12.5px]">
                      <a {...sourceLinkProps(source)} className="text-primary hover:underline">{text}</a>
                      <p className="text-muted-foreground">{sourceLabel(source)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null;
          })}
        </>
      ) : null}
      {themes.length > 0 ? (
        <>
          <h3 className={SECTION_HEADING}>Topik utama</h3>
          <ul className="mt-2 space-y-3">
            {themes.map(({ title, stance, description, sources }) => {
              const sourcePlatforms = [...new Set(sources.map((source) => platformName(source.platform)))];
              const hasPosts = sources.some((source) => source.kind === "post");
              const hasReplies = sources.some((source) => source.kind === "reply");
              const units = hasPosts && hasReplies ? "unggahan dan balasan" : hasPosts ? "unggahan" : "balasan";
              return (
                <li key={title}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-[13.5px] font-semibold text-foreground">{title}</h4>
                    <StanceChip stance={stance} />
                  </div>
                  <p className="text-[12.5px] text-foreground">{description}</p>
                  <p className="text-[12px] text-muted-foreground">
                    {sources.length} {units} · {sourcePlatforms.join(", ")}
                  </p>
                  <EvidenceLinks sources={sources} label={`Sumber topik ${title}`} />
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {platforms.length ? (
        <>
          <h3 className={SECTION_HEADING}>Sikap per platform</h3>
          <ul className="mt-2 space-y-2">
            {platforms.map(({ platform, stance, sources }) => (
              <li key={platform}>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <PlatformTile platform={platform} size={16} />
                  <span>{platformName(platform)}</span>
                  <StanceChip stance={stance} />
                </div>
                <EvidenceLinks sources={sources} label={`Sumber sikap ${platformName(platform)}`} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
