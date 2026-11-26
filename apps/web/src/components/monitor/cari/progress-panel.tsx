"use client";

import { useId, useState } from "react";
import { Check, ChevronDown, Circle, Clock3 } from "lucide-react";
import { cn } from "cn";
import type { SearchSnapshot, SnapshotSource } from "@/monitor/search/load";
import { PlatformTile, platformName } from "./platform-tile";
import { MoreSourceControl, type MoreSourceActions } from "./more-source-control";
import { elapsedSeconds } from "./snapshot-format";

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

function SourceRow(props: { source: SnapshotSource; max: number; moreActions?: MoreSourceActions }) {
  const source = props.source;
  const label = STATE_LABEL[source.state] ?? source.state;
  const active = source.state === "searching" || source.state === "queued";
  const answered = source.state === "answered";
  const width = source.resultCount > 0 ? Math.max(4, Math.round((source.resultCount / props.max) * 100)) : 0;
  const latency = source.latencyMs == null ? null : `${(source.latencyMs / 1000).toFixed(1).replace(".", ",")} dtk`;
  const sourceStatus = (
    <span className="min-w-0 wrap-anywhere text-right text-[11px] leading-tight text-muted-foreground">
      {source.state === "failed" ? (
        source.safeDetail === "deadline" ? "Gagal · waktu habis" : "Gagal"
      ) : active ? (
        "Mencari"
      ) : source.safeDetail === "hashtag_only" ? (
        "Hanya mendukung tagar"
      ) : source.safeDetail === "partial_coverage" ? (
        "Cakupan sebagian"
      ) : source.safeDetail === "web_index_selection" ? (
        answered && source.resultCount === 0 ? "0 hasil · cakupan indeks terbatas" : "Cakupan indeks terbatas"
      ) : answered && source.resultCount === 0 ? (
        <span className="font-medium text-foreground">Selesai · 0 hasil</span>
      ) : answered ? (
        <span>
          <span className="font-medium text-foreground">Selesai</span>{latency ? ` · ${latency}` : ""}
        </span>
      ) : source.safeDetail === "deadline" ? (
        "waktu habis"
      ) : (
        label
      )}
    </span>
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[13px] @min-[480px]:grid-cols-[minmax(100px,1fr)_minmax(0,2fr)_32px_minmax(140px,2fr)]">
      <span className="flex min-w-0 items-center gap-2">
        <PlatformTile platform={source.platform} size={18} />
        <span className="truncate">{platformName(source.platform)}</span>
      </span>
      <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-sm bg-surface-subtle">
        <div
          className={cn("cari-progress-bar h-full", active ? "bg-primary/50" : "bg-primary")}
          style={{ width: `${active ? 50 : width}%` }}
        />
      </div>
      <span className="text-right tabular-nums">{answered ? source.resultCount : "—"}</span>
      <div className="col-span-full flex min-w-0 justify-end [&_button]:min-h-11 @min-[480px]:col-span-1">
        {source.more && props.moreActions ? (
          <MoreSourceControl platform={source.platform} more={source.more} actions={props.moreActions} sourceStatus={sourceStatus} />
        ) : sourceStatus}
      </div>
    </div>
  );
}

function ProgressStep({ label, status, active, done }: { label: string; status: string; active: boolean; done: boolean }) {
  const Icon = done ? Check : active ? Clock3 : Circle;
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Icon className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", done && "text-positif", active && "text-primary")} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{status}</p>
      </div>
    </li>
  );
}

export function ProgressPanel(props: { snapshot: SearchSnapshot; now?: Date; aiEnabled?: boolean; moreActions?: MoreSourceActions }) {
  const snapshot = props.snapshot;
  const [detailsChoice, setDetailsChoice] = useState<boolean>();
  const detailsId = useId();
  const detailsOpen = detailsChoice ?? snapshot.results.length === 0;
  const now = props.now ?? new Date();
  const done = snapshot.totals.done;
  const total = snapshot.totals.sources;
  const max = Math.max(1, ...snapshot.sources.map((source) => source.resultCount));
  const running = snapshot.search.status === "queued" || snapshot.search.status === "running";
  const elapsed = elapsedSeconds(snapshot, now);
  const sourcesBusy = snapshot.sources.some((source) => source.state === "queued" || source.state === "searching");
  const commentCount = snapshot.comments.length;
  const commentStatus = snapshot.search.commentStatus ?? "pending";
  const commentDetail = snapshot.search.commentDetail ?? null;
  const commentCopy =
    commentStatus === "done" || commentCount > 0
      ? commentCount > 0
        ? `Selesai · ${commentCount} balasan`
        : "Selesai · tidak ada balasan"
      : commentStatus === "running"
        ? "Mengambil balasan teratas"
        : commentStatus === "skipped" && commentDetail === "comment_budget"
          ? "Dilewati · waktu habis"
          : commentStatus === "skipped" && commentDetail === "no_posts"
            ? "Dilewati · tidak ada postingan yang cocok"
            : commentStatus === "skipped" && commentDetail === "no_provider"
              ? "Dilewati · sumber tidak mendukung"
              : commentStatus === "skipped" && commentDetail === "calls_failed"
                ? "Dilewati · gagal mengambil"
                : commentStatus === "skipped"
                  ? "Dilewati · tidak ada balasan"
                : sourcesBusy
                  ? "Menunggu · sumber masih berjalan"
                  : running
                    ? "Mengambil balasan teratas"
                    : "Dilewati · tidak ada balasan";
  const commentRunning = commentStatus === "running" || (running && !sourcesBusy && commentStatus === "pending");
  const commentDone = commentStatus === "done" || commentCount > 0;
  const summaryStatus = snapshot.search.summaryStatus ?? "pending";
  const summaryCopy =
    summaryStatus === "done"
      ? "Selesai"
      : summaryStatus === "running"
        ? "Menulis ringkasan"
        : summaryStatus === "failed"
          ? "Gagal · hasil tetap tampil"
          : summaryStatus === "insufficient"
            ? "Dilewati · bukti belum cukup"
            : summaryStatus === "skipped"
              ? "Dilewati"
              : "Menunggu · setelah komentar";
  const summaryDone = summaryStatus === "done";
  const summaryRunning = summaryStatus === "running";
  const sourcesStatus = sourcesBusy
    ? "Sedang berjalan"
    : snapshot.search.status === "failed"
      ? "Pencarian gagal"
      : running && done === 0
        ? "Menunggu"
        : "Sumber selesai";

  return (
    <section className="rounded-xl border border-border bg-surface shadow-card">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="font-semibold tabular-nums text-foreground">
            {snapshot.totals.results} hasil cocok
          </h2>
          <p className="text-xs tabular-nums text-muted-foreground">
            {done}/{total} sumber selesai{elapsed === null ? "" : ` · ${elapsed} dtk`}
          </p>
        </div>
        <ol className={cn("grid gap-2.5 sm:gap-3", props.aiEnabled ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          <ProgressStep
            label="Mencari sumber"
            status={sourcesStatus}
            active={sourcesBusy}
            done={!sourcesBusy && !running && snapshot.search.status !== "failed"}
          />
          <ProgressStep label="Komentar" status={commentCopy} active={commentRunning} done={commentDone} />
          {props.aiEnabled ? (
            <ProgressStep label="Ringkasan AI" status={summaryCopy} active={summaryRunning} done={summaryDone} />
          ) : null}
        </ol>
      </div>
      {snapshot.sources.length > 0 ? (
        <div className="border-t border-border">
          <button
            type="button"
            className="workspace-feedback flex min-h-11 w-full items-center justify-between gap-2 rounded-b-xl px-3 text-left text-sm font-medium text-foreground hover:bg-surface-subtle sm:px-4"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsChoice(!detailsOpen)}
          >
            Rincian sumber
            <ChevronDown className={cn("size-4 shrink-0", detailsOpen && "rotate-180")} aria-hidden="true" />
          </button>
          <div
            id={detailsId}
            hidden={!detailsOpen}
            onFocusCapture={() => setDetailsChoice(true)}
          >
            <div className="cari-reveal grid gap-4 px-3 pb-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_180px] lg:items-start">
              <div className="@container min-w-0 space-y-2.5">
                {snapshot.sources.map((source) => (
                  <SourceRow key={source.platform} source={source} max={max} moreActions={props.moreActions} />
                ))}
              </div>
              <div className="hidden lg:block">
                <DotMap total={total} done={done} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
