import type { SnapshotResult } from "@/monitor/search/load";
import { EvidenceLink, EvidenceLinks } from "./evidence-links";
import { PlatformTile, platformName } from "./platform-tile";
import {
  QUOTE_LABELS, sourceLabel, type supportedPlatforms, type supportedQuotes, type supportedThemes,
} from "./quote-source";
import { StanceChip } from "./stance-chip";

const SECTION_HEADING = "mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

export function ConversationBreakdown({ results, platforms, quotes, themes }: {
  results: SnapshotResult[];
  platforms: ReturnType<typeof supportedPlatforms>;
  quotes: ReturnType<typeof supportedQuotes>;
  themes: ReturnType<typeof supportedThemes>;
}) {
  const resultCounts = new Map<string, number>();
  for (const result of results) {
    resultCounts.set(result.platform, (resultCounts.get(result.platform) ?? 0) + 1);
  }
  const maxCount = Math.max(1, ...resultCounts.values());

  return (
    <section className="min-w-0">
      <h3 className="mt-2 text-sm font-semibold text-foreground">Bagaimana percakapannya</h3>
      <h4 className={SECTION_HEADING}>Hasil per platform</h4>
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
          <h4 className={SECTION_HEADING}>Kutipan</h4>
          {QUOTE_LABELS.map(([type, label]) => {
            const group = quotes.filter((quote) => quote.type === type);
            return group.length ? (
              <div key={type} className="mt-3">
                <h5 className="text-[12px] font-semibold text-foreground">{label}</h5>
                <ul className="mt-1 space-y-2">
                  {group.map(({ text, source }) => (
                    <li key={text} className="border-l-2 border-border pl-2 text-[12.5px]">
                      <EvidenceLink source={source} className="flex min-h-11 min-w-11 items-center py-1 wrap-anywhere text-primary hover:underline">
                        {text}
                      </EvidenceLink>
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
          <h4 className={SECTION_HEADING}>Topik utama</h4>
          <ul className="mt-2 space-y-3">
            {themes.map(({ title, stance, description, sources }) => {
              const sourcePlatforms = [...new Set(sources.map((source) => platformName(source.platform)))];
              const hasPosts = sources.some((source) => source.kind === "post");
              const hasReplies = sources.some((source) => source.kind === "reply");
              const units = hasPosts && hasReplies ? "unggahan dan balasan" : hasPosts ? "unggahan" : "balasan";
              return (
                <li key={title}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h5 className="text-[13.5px] font-semibold wrap-anywhere text-foreground">{title}</h5>
                    <StanceChip stance={stance} />
                  </div>
                  <p className="text-[12.5px] wrap-anywhere text-foreground">{description}</p>
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
          <h4 className={SECTION_HEADING}>Sikap per platform</h4>
          <ul className="mt-2 space-y-2">
            {platforms.map(({ platform, stance, summary, sources }) => (
              <li key={platform}>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <PlatformTile platform={platform} size={16} />
                  <span>{platformName(platform)}</span>
                  <StanceChip stance={stance} />
                </div>
                <p className="mt-1 text-sm leading-5 wrap-anywhere text-foreground">{summary}</p>
                <EvidenceLinks sources={sources} label={`Sumber sikap ${platformName(platform)}`} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
