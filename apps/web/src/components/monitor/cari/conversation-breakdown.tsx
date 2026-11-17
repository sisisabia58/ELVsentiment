import type { SearchSnapshot } from "@/monitor/search/load";
import { PlatformTile, platformName } from "./platform-tile";

const STANCE_LABEL: Record<string, string> = {
  positif: "Positif",
  campuran: "Campuran",
  negatif: "Negatif",
  netral: "Netral",
  faktual: "Faktual",
};

const STANCE_BAR: Record<string, string> = {
  positif: "bg-positif",
  campuran: "bg-warning",
  negatif: "bg-negatif",
  netral: "bg-netral",
  faktual: "bg-info",
};

const QUOTE_LABEL: Record<string, string> = {
  pujian: "Pujian",
  keluhan: "Keluhan",
  pengamatan: "Pengamatan",
  pertanyaan: "Pertanyaan",
};

type PlatformSummary = { platform?: string; stance?: string };
type Quote = { type?: string; text?: string; author?: string; platform?: string };
type Theme = { title?: string; description?: string; supporting_ids?: unknown; platforms?: unknown };

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function ConversationBreakdown(props: { snapshot: SearchSnapshot }) {
  const snapshot = props.snapshot;
  const summaries = asList<PlatformSummary>(snapshot.ai?.platformSummaries);
  const stanceByPlatform = new Map<string, string>();
  for (const item of summaries) {
    if (item.platform && item.stance && item.stance in STANCE_LABEL) {
      stanceByPlatform.set(item.platform, item.stance);
    }
  }
  const resultCounts = new Map<string, number>();
  const stanceCounts = new Map<string, number>();
  for (const result of snapshot.results) {
    resultCounts.set(result.platform, (resultCounts.get(result.platform) ?? 0) + 1);
    const stance = stanceByPlatform.get(result.platform);
    if (stance) stanceCounts.set(stance, (stanceCounts.get(stance) ?? 0) + 1);
  }
  const classified = [...stanceCounts.values()].reduce((sum, count) => sum + count, 0);
  const maxCount = Math.max(1, ...resultCounts.values());
  const quotes = asList<Quote>(snapshot.ai?.quotes).filter((item) => item.text);
  const themes = asList<Theme>(snapshot.ai?.themes).filter((item) => item.title);
  const stanceOrder = ["positif", "campuran", "negatif", "netral", "faktual"].filter(
    (stance) => stance !== "faktual" || (stanceCounts.get(stance) ?? 0) > 0,
  );
  return (
    <section className="mt-8 rounded-[14px] border border-border bg-surface p-5 shadow-card">
      <h2 className="text-[16px] font-semibold text-foreground">Bagaimana percakapannya</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">Dihitung dari hasil di atas, bukan survei.</p>
      <h3 className="mt-4 text-[11px] font-semibold tracking-wide text-muted-foreground">HASIL PER PLATFORM</h3>
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
      <h3 className="mt-5 text-[11px] font-semibold tracking-wide text-muted-foreground">SIKAP PER PLATFORM</h3>
      <ul className="mt-2 space-y-2">
        {[...stanceByPlatform.entries()].map(([platform, stance]) => (
          <li key={platform} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2 text-[13px]">
            <span>{platformName(platform)}</span>
            <span className="flex h-2 overflow-hidden rounded-sm bg-surface-subtle">
              <span className={`block h-full w-full ${STANCE_BAR[stance] ?? "bg-netral"}`} />
            </span>
          </li>
        ))}
      </ul>
      {classified > 0 ? (
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          {stanceOrder
            .filter((stance) => (stanceCounts.get(stance) ?? 0) > 0)
            .map((stance) => `${STANCE_LABEL[stance]} ${Math.round(((stanceCounts.get(stance) ?? 0) / classified) * 100)}%`)
            .join(" · ")}
        </p>
      ) : null}
      {quotes.length > 0 ? (
        <>
          <h3 className="mt-5 text-[11px] font-semibold tracking-wide text-muted-foreground">APA KATA ORANG</h3>
          <ul className="mt-2 space-y-2">
            {quotes.map((quote, index) => (
              <li key={`${quote.text}-${index}`} className="rounded-lg border border-border px-3 py-2">
                <span className="text-[11px] font-semibold text-primary">{QUOTE_LABEL[quote.type ?? ""] ?? quote.type}</span>
                <p className="text-[13px] text-foreground">{quote.text}</p>
                {quote.author ? <p className="font-mono text-[11px] text-muted-foreground">{quote.author}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {themes.length > 0 ? (
        <>
          <h3 className="mt-5 text-[11px] font-semibold tracking-wide text-muted-foreground">TOPIK UTAMA</h3>
          <ul className="mt-2 space-y-2">
            {themes.map((theme) => {
              const supporting = Array.isArray(theme.supporting_ids) ? theme.supporting_ids.length : 0;
              const platforms = Array.isArray(theme.platforms) ? theme.platforms.filter((item) => typeof item === "string") : [];
              return (
                <li key={theme.title}>
                  <p className="text-[13.5px] font-semibold text-foreground">{theme.title}</p>
                  {theme.description ? <p className="text-[12.5px] text-muted-foreground">{theme.description}</p> : null}
                  <p className="text-[12px] text-muted-foreground">
                    {supporting} kutipan · {platforms.map((platform) => platformName(String(platform))).join(", ")}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
