"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Clock, MessageSquareText, Search, Sparkles } from "lucide-react";
import { formatRelative } from "@/monitor/format";
import {
  DATE_LABEL,
  DEFAULT_FILTERS,
  LANGUAGE_LABEL,
  SORT_LABEL,
  type SearchFilters,
} from "@/monitor/search/filters";
import type { SearchSnapshot, SnapshotComment } from "@/monitor/search/load";
import { LAUNCH_PLATFORMS, SEARCH_PLATFORM_NAME } from "@/monitor/search/platforms";
import { startSearchAction } from "@/app/cari/start-action";
import { SearchForm, EXAMPLE_SEARCHES, type SearchFormInput } from "./search-form";
import { PlatformTile } from "./platform-tile";
import { AiSummary } from "./ai-summary";
import { ConversationBreakdown } from "./conversation-breakdown";
import { AskPanel } from "./ask-panel";
import { ProgressPanel } from "./progress-panel";
import { ResultsList } from "./results-list";
import { StanceChip } from "./stance-chip";
import { elapsedSeconds } from "./snapshot-format";
import { useSearchPoll } from "./use-search-poll";

export type SearchHistoryRow = {
  id: string;
  query: string;
  resultCount: number;
  sourceCount: number;
  stance: string | null;
  status: string;
  createdAt: string;
};

const FAILED_SEARCH_COPY: Record<string, string> = {
  deadline: "Waktu pencarian habis sebelum semua sumber menjawab.",
  all_sources_failed: "Tidak ada sumber yang berhasil menjawab. Coba lagi sebentar lagi.",
  storage_failed: "Hasil pencarian gagal disimpan. Coba lagi sebentar lagi.",
};

const FAILED_SEARCH_FALLBACK = "Pencarian gagal. Coba lagi sebentar lagi.";

const ERROR_COPY: Record<string, string> = {
  disabled: "Cari sekarang belum tersedia.",
  unauthenticated: "Sesi Anda berakhir. Masuk lagi untuk mencari.",
  daily_limit: "Batas pencarian hari ini sudah tercapai. Coba lagi besok.",
  invalid_query: "Kata kunci minimal 2 karakter.",
  query_too_long: "Kata kunci maksimal 160 karakter.",
};

function RecentSearches(props: { history: SearchHistoryRow[]; now: string; aiEnabled: boolean }) {
  return (
    <section className="mt-8 rounded-[14px] border border-border bg-surface shadow-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h3 className="text-[15px] font-semibold text-foreground">Pencarian terakhir</h3>
        <Link href="/cari/riwayat" className="text-[13px] font-medium text-primary">
          Lihat semua
        </Link>
      </div>
      {props.history.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-muted-foreground">Belum ada pencarian. Coba kata kunci pertama Anda.</p>
      ) : (
        <ul className="divide-y divide-border text-[13.5px]">
          {props.history.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-5 py-3">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Link href={`/cari/${row.id}`} className="min-w-0 flex-1 truncate font-medium text-foreground hover:text-primary">
                {row.query}
              </Link>
              <span className="hidden text-muted-foreground sm:inline">
                {row.resultCount} hasil · {row.sourceCount} sumber
              </span>
                {props.aiEnabled && row.stance ? <StanceChip stance={row.stance} /> : null}
              <span className="w-20 text-right text-[12px] text-muted-foreground">
                {formatRelative(row.createdAt, new Date(props.now))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const LAUNCH_SOURCE_NAMES = LAUNCH_PLATFORMS.map((platform) => SEARCH_PLATFORM_NAME[platform]);
const LAUNCH_SOURCE_SUMMARY = `${LAUNCH_SOURCE_NAMES.slice(0, -1).join(", ")}, dan ${LAUNCH_SOURCE_NAMES[LAUNCH_SOURCE_NAMES.length - 1]}`;

function filterSummary(filters: SearchSnapshot["search"]["filters"]): string {
  const parts = [DATE_LABEL[filters.dateWindow], SORT_LABEL[filters.sort]];
  if (filters.language !== "all") parts.push(LANGUAGE_LABEL[filters.language]);
  return parts.join(" · ");
}

// Server HTML and the first client render must agree. Seed the clock from the
// server-provided `now` and only start ticking after mount.
function useNow(initialIso: string | undefined): Date {
  const [now, setNow] = useState(() => new Date(initialIso ?? 0));
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function SearchBody(props: { snapshot: SearchSnapshot; now: Date; aiEnabled: boolean; running: boolean }) {
  const snapshot = props.snapshot;
  if (snapshot.results.length === 0 && !props.aiEnabled) return null;
  const results = snapshot.results.length > 0 ? (
    <ResultsList
      results={snapshot.results}
      commentsByResult={commentsByResult(snapshot)}
      sortMode={snapshot.search.filters.sort}
      now={props.now}
    />
  ) : null;
  if (!props.aiEnabled || props.running) {
    return results ? <div className="mt-5">{results}</div> : null;
  }
  const counts: Record<string, number> = {};
  for (const result of snapshot.results) counts[result.platform] = (counts[result.platform] ?? 0) + 1;
  const summaryStatus = snapshot.search.summaryStatus === "pending" ? "failed" : snapshot.search.summaryStatus;
  return (
    <div className="mt-5 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-5">
      <aside className="order-first mb-5 lg:order-2 lg:mb-0 lg:sticky lg:top-4">
        <AiSummary
          ai={snapshot.ai}
          summaryStatus={summaryStatus}
          resultCount={snapshot.totals.results}
          commentCount={snapshot.comments.length}
          platformCounts={counts}
          results={snapshot.results}
          comments={snapshot.comments}
        />
      </aside>
      <div className="min-w-0 lg:order-1">
        {results}
        {snapshot.ai && snapshot.results.length > 0 ? <ConversationBreakdown snapshot={snapshot} /> : null}
        <div className="mt-5">
          <AskPanel
            searchId={snapshot.search.id}
            questions={snapshot.questions}
            suggestions={["Apa keluhan utama?", "Apa yang dipuji?", "Platform mana yang paling ramai?"]}
            results={snapshot.results}
            comments={snapshot.comments}
            resultCount={snapshot.totals.results}
          />
        </div>
      </div>
    </div>
  );
}

function commentsByResult(snapshot: SearchSnapshot): Record<string, SnapshotComment[]> {
  const grouped: Record<string, SnapshotComment[]> = {};
  for (const comment of snapshot.comments) {
    grouped[comment.resultId] = [...(grouped[comment.resultId] ?? []), comment];
  }
  return grouped;
}

export function SearchDetail(props: { initialSnapshot: SearchSnapshot; now?: string; aiEnabled?: boolean }) {
  const { snapshot, stale } = useSearchPoll(
    props.initialSnapshot.search.id,
    props.initialSnapshot,
  );
  const now = useNow(props.now);
  const search = snapshot.search;
  const running = search.status === "queued" || search.status === "running";
  const done = snapshot.totals.done;
  const total = snapshot.totals.sources;
  const elapsed = elapsedSeconds(snapshot, now);
  const receipt = running
    ? [
        "Sedang berjalan",
        `${done} dari ${total} sumber selesai`,
        `${snapshot.totals.results} hasil sejauh ini`,
      ]
    : [`${done} dari ${total} sumber menjawab`, `${snapshot.totals.results} hasil`];
  if (!running && elapsed !== null) receipt.push(`${elapsed} dtk`);
  const failureCopy =
    !running && (search.errorCode !== null || search.status === "failed")
      ? (search.errorCode ? FAILED_SEARCH_COPY[search.errorCode] : null) ?? FAILED_SEARCH_FALLBACK
      : null;
  return (
    <div className="mt-5">
      <section className="rounded-[14px] border border-border bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 pt-4 font-mono text-[13px]">
          <span className="font-semibold text-primary">$</span>
          <span>cari &quot;{search.query}&quot;</span>
          <span className="text-muted-foreground">{filterSummary(search.filters)}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-4 pt-2">
          <p className="font-mono text-[12.5px] text-muted-foreground">{receipt.join(" · ")}</p>
        </div>
      </section>
      {failureCopy ? (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-negatif/30 bg-negatif-bg px-3 py-2 text-[13px] text-negatif"
        >
          {failureCopy}
        </p>
      ) : null}
      {stale ? (
        <p className="mt-2 text-[12px] text-muted-foreground" role="status">
          Koneksi terputus. Menampilkan hasil terakhir.
        </p>
      ) : null}
      <div className="mt-5">
        <ProgressPanel snapshot={snapshot} now={now} aiEnabled={props.aiEnabled} />
      </div>
      <SearchBody snapshot={snapshot} now={now} aiEnabled={props.aiEnabled === true} running={running} />
    </div>
  );
}

export function SearchScreen(props: { history: SearchHistoryRow[]; now: string; aiEnabled?: boolean }) {
  const aiEnabled = props.aiEnabled ?? false;
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(input: SearchFormInput) {
    setStarting(true);
    setError(null);
    try {
      const result = await startSearchAction(input);
      if (result.ok) {
        router.push(`/cari/${result.searchId}`);
        return;
      }
      setError(ERROR_COPY[result.error] ?? "Pencarian gagal dimulai. Coba lagi.");
    } catch {
      setError("Pencarian gagal dimulai. Coba lagi.");
    } finally {
      setStarting(false);
    }
  }

  async function startExample(query: string, filters: SearchFilters = DEFAULT_FILTERS) {
    await start({ query, filters });
  }

  return (
    <div className="mt-5">
      <section className="mx-auto max-w-[760px] pt-4 text-center lg:pt-10">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12px] font-medium text-muted-foreground shadow-card">
          <span className="h-1.5 w-1.5 rounded-full bg-positif" aria-hidden="true" />
          {LAUNCH_PLATFORMS.length} sumber siap · hasil dalam ±30 detik
        </span>
        <h2 className="mt-5 text-[28px] font-semibold leading-tight tracking-tight text-foreground lg:text-[36px]">
          Apa kata orang tentang merek Anda?
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-[15px] leading-6 text-muted-foreground">
          {aiEnabled
            ? "Ketik merek, produk, atau topik. Kami mencari di media sosial dan web sekarang juga, lalu merangkum apa yang dibicarakan — lengkap dengan kutipan aslinya."
            : "Ketik merek, produk, atau topik. Kami mencari di media sosial dan web, lalu menampilkan hasilnya."}
        </p>
      </section>

      <div className="mx-auto mt-6 max-w-[960px]">
        <div onClickCapture={(event) => event.stopPropagation()}>
          <SearchForm onSubmit={start} pending={starting} />
        </div>
        {error ? (
          <p role="alert" className="mt-2 rounded-lg border border-negatif/30 bg-negatif-bg px-3 py-2 text-[13px] text-negatif">
            {error}
          </p>
        ) : null}
      </div>

      <section className="mx-auto mt-8 max-w-[960px]">
        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground">COBA CONTOH PENCARIAN</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {EXAMPLE_SEARCHES.map((example, index) => (
            <button
              key={example.query}
              type="button"
              disabled={starting}
              onClick={() => void startExample(example.query)}
              className="group flex items-center gap-3 rounded-[14px] border border-border bg-surface p-4 text-left shadow-card transition hover:border-primary/40 hover:shadow-float disabled:opacity-60"
            >
              <PlatformTile platform={LAUNCH_PLATFORMS[index] ?? "threads"} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-foreground">{example.query}</span>
                <span className="block text-[12px] text-muted-foreground">{example.label}</span>
              </span>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
            </button>
          ))}
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {[
            {
              icon: Search,
              title: `Cari di ${LAUNCH_PLATFORMS.length} sumber`,
              body: `${LAUNCH_SOURCE_SUMMARY} — semuanya sekaligus.`,
            },
            {
              icon: MessageSquareText,
              title: "Baca komentar teratas",
              body: "Balasan pada 3 pos teratas tiap sumber ikut diambil. Kartu menampilkan sampai 3 balasan; sisanya hanya angka.",
            },
            ...(aiEnabled
              ? [
                  {
                    icon: Sparkles,
                    title: "Dapat ringkasan AI",
                    body: "Sikap per platform, kutipan asli, dan topik utama — lalu tanyakan apa saja tentang hasilnya.",
                  },
                ]
              : []),
          ].map((panel, index) => {
            const Icon = panel.icon;
            return (
              <div key={panel.title} className="rounded-[14px] border border-border bg-surface p-5 shadow-card">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-info-bg text-primary">
                  {index === 0 ? <span className="text-[13px] font-semibold">1</span> : <Icon className="h-4 w-4" aria-hidden="true" />}
                </span>
                <h3 className="mt-3 text-[15px] font-semibold text-foreground">{panel.title}</h3>
                <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{panel.body}</p>
              </div>
            );
          })}
        </div>

        <RecentSearches history={props.history} now={props.now} aiEnabled={aiEnabled} />
      </section>
    </div>
  );
}
