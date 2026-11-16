import { Check, Loader2 } from "lucide-react";
import { cn } from "cn";
import type { SearchSnapshot, SnapshotSource } from "@/monitor/search/load";
import { PlatformTile, platformName } from "./platform-tile";
import { elapsedSeconds, knownCredits } from "./snapshot-format";

// Komentar and Ringkasan AI belong to M4/M5. Keep them out of the progress
// panel until those milestones ship.
const SHOW_UPCOMING_STEPS = false;

const STATE_LABEL: Record<string, string> = {
  answered: "Selesai",
  searching: "Mencari",
  queued: "Mencari",
  unavailable: "Tidak tersedia",
  failed: "Gagal",
};

function DotMap(props: { total: number; done: number }) {
  const dots: Array<{ x: number; y: number; on: boolean }> = [];
  for (let y = 8; y < 152; y += 7) {
    for (let x = 8; x < 292; x += 7) {
      const nx = x / 300;
      const ny = y / 160;
      const inBlob =
        ((nx - 0.2) / 0.15) ** 2 + ((ny - 0.3) / 0.2) ** 2 < 1 ||
        ((nx - 0.49) / 0.07) ** 2 + ((ny - 0.26) / 0.1) ** 2 < 1 ||
        ((nx - 0.7) / 0.19) ** 2 + ((ny - 0.3) / 0.18) ** 2 < 1 ||
        ((nx - 0.29) / 0.07) ** 2 + ((ny - 0.72) / 0.2) ** 2 < 1 ||
        ((nx - 0.53) / 0.09) ** 2 + ((ny - 0.6) / 0.2) ** 2 < 1 ||
        ((nx - 0.89) / 0.07) ** 2 + ((ny - 0.8) / 0.09) ** 2 < 1;
      if (!inBlob) continue;
      const on = (dots.length + props.done) % 4 === 0;
      dots.push({ x, y, on });
    }
  }
  return (
    <svg viewBox="0 0 300 160" className="w-full" aria-hidden="true">
      {dots.map((dot, index) => (
        <circle
          key={`${dot.x}-${dot.y}-${index}`}
          cx={dot.x}
          cy={dot.y}
          r="1.9"
          fill={dot.on ? "#1d4ed8" : "#cbd5e1"}
          className={dot.on ? "animate-pulse" : undefined}
        />
      ))}
      {props.total > 0 ? (
        <>
          <circle cx="234" cy="96" r="5" fill="none" stroke="#1d4ed8" strokeWidth="1.5" />
          <circle cx="234" cy="96" r="3" fill="#1d4ed8" />
          <circle cx="60" cy="52" r="3" fill="#1d4ed8" />
        </>
      ) : null}
    </svg>
  );
}

function SourceRow(props: { source: SnapshotSource; max: number }) {
  const source = props.source;
  const label = STATE_LABEL[source.state] ?? source.state;
  const width = props.max > 0 ? Math.max(4, Math.round((source.resultCount / props.max) * 100)) : 0;
  const latency =
    source.latencyMs != null
      ? `${(source.latencyMs / 1000).toFixed(1).replace(".", ",")} dtk`
      : source.state === "searching" || source.state === "queued"
        ? "…"
        : "—";
  return (
    <div
      className={cn(
        "grid grid-cols-[14px_112px_minmax(0,1fr)_32px_84px] items-center gap-2 text-[13px]",
        (source.state === "unavailable" || source.state === "failed") && "opacity-70",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          source.state === "answered"
            ? "bg-positif"
            : source.state === "searching" || source.state === "queued"
              ? "animate-pulse bg-primary"
              : "border border-muted-foreground",
        )}
        aria-hidden="true"
      />
      <span className="flex items-center gap-2 truncate">
        <PlatformTile platform={source.platform} size={18} />
        <span className="truncate">{platformName(source.platform)}</span>
      </span>
      <div className="h-2.5 w-full overflow-hidden rounded-sm bg-surface-subtle">
        {source.state === "answered" ? (
          <div className="h-full bg-primary" style={{ width: `${width}%` }} />
        ) : source.state === "searching" || source.state === "queued" ? (
          <div className="h-full w-1/2 animate-pulse bg-primary/50" />
        ) : null}
      </div>
      <span className="text-right tabular-nums">{source.state === "answered" ? source.resultCount : "—"}</span>
      <span className="text-right text-[11px] text-muted-foreground">
        {source.state === "answered" ? (
          <span>
            <span className="font-medium text-foreground">Selesai</span> · {latency}
          </span>
        ) : source.state === "searching" || source.state === "queued" ? (
          <span>Mencari</span>
        ) : (
          label
        )}
      </span>
    </div>
  );
}

export function ProgressPanel(props: { snapshot: SearchSnapshot; now?: Date }) {
  const snapshot = props.snapshot;
  const now = props.now ?? new Date();
  const done = snapshot.totals.done;
  const total = snapshot.totals.sources;
  const max = Math.max(1, ...snapshot.sources.map((source) => source.resultCount));
  const finished = ["succeeded", "partial", "failed"].includes(snapshot.search.status);
  const running = !finished;
  const elapsed = elapsedSeconds(snapshot, now);
  const credits = knownCredits(snapshot);

  return (
    <section className="rounded-[14px] border border-border bg-surface shadow-card">
      <div className="grid gap-0 md:grid-cols-[300px_minmax(0,1fr)]">
        <div className="relative border-b border-border p-5 md:border-b-0 md:border-r">
          <DotMap total={total} done={done} />
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[20px] font-semibold tabular-nums text-foreground">
                {done}/{total}
              </p>
              <p className="text-[11px] text-muted-foreground">sumber selesai</p>
            </div>
            <div>
              <p className="text-[20px] font-semibold tabular-nums text-foreground">
                {snapshot.totals.results} hasil
              </p>
              <p className="text-[11px] text-muted-foreground">terkumpul</p>
            </div>
            <div>
              <p className="text-[20px] font-semibold tabular-nums text-foreground">
                {elapsed === null ? "—" : `${elapsed} dtk`}
              </p>
              <p className="text-[11px] text-muted-foreground">{running ? "berjalan" : "selesai"}</p>
            </div>
          </div>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
              ) : (
                <Check className="h-4 w-4 text-positif" aria-hidden="true" />
              )}
              {running ? `Mencari ${total} sumber` : `${total} sumber`}
            </h2>
            {credits !== null ? (
              <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[11.5px] font-medium text-foreground">
                {credits} kredit
              </span>
            ) : null}
          </div>
          <div className="mt-4 space-y-2.5">
            {snapshot.sources.map((source) => (
              <SourceRow key={source.platform} source={source} max={max} />
            ))}
          </div>
        </div>
      </div>
      <ol className={cn("grid border-t border-border", SHOW_UPCOMING_STEPS && "sm:grid-cols-3")}>
        <li className="flex items-center gap-3 px-5 py-3.5">
          <span
            className={cn(
              "grid h-7 w-7 place-items-center rounded-full",
              running ? "bg-primary text-primary-foreground" : "bg-positif-bg text-positif",
            )}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
          </span>
          <div>
            <p className="text-[13px] font-semibold text-foreground">Mencari sumber</p>
            <p className="text-[11.5px] text-muted-foreground">
              {done} dari {total} selesai
            </p>
          </div>
        </li>
        {SHOW_UPCOMING_STEPS ? (
          <>
            <li className="flex items-center gap-3 border-t border-border px-5 py-3.5 sm:border-l sm:border-t-0">
              <span className="grid h-7 w-7 place-items-center rounded-full border border-border text-[12px] font-semibold text-muted-foreground">
                2
              </span>
              <div>
                <p className="text-[13px] font-semibold text-foreground">Komentar</p>
                <p className="text-[11.5px] text-muted-foreground">Menunggu · ambil balasan teratas</p>
              </div>
            </li>
            <li className="flex items-center gap-3 border-t border-border px-5 py-3.5 sm:border-l sm:border-t-0">
              <span className="grid h-7 w-7 place-items-center rounded-full border border-border text-[12px] font-semibold text-muted-foreground">
                3
              </span>
              <div>
                <p className="text-[13px] font-semibold text-foreground">Ringkasan AI</p>
                <p className="text-[11.5px] text-muted-foreground">Menunggu · ±10 detik</p>
              </div>
            </li>
          </>
        ) : null}
      </ol>
    </section>
  );
}
