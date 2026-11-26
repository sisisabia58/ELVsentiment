"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, MessageSquareText, Search, Sparkles } from "lucide-react";
import {
  DATE_LABEL,
  DEFAULT_FILTERS,
  LANGUAGE_LABEL,
  SORT_LABEL,
  type SearchFilters,
} from "@/monitor/search/filters";
import type { SearchSnapshot, SnapshotComment } from "@/monitor/search/load";
import { LAUNCH_PLATFORMS, SEARCH_PLATFORM_NAME } from "@/monitor/search/platforms";
import { monitorAsProjectAction, startMoreSourceAction, startSearchAction } from "@/app/cari/start-action";
import { SearchForm, EXAMPLE_SEARCHES, type SearchFormInput } from "./search-form";
import { HistoryList } from "./history-list";
import { PlatformTile } from "./platform-tile";
import { AiSummary } from "./ai-summary";
import { AskPanel } from "./ask-panel";
import type { MoreSourceActions } from "./more-source-control";
import { ProgressPanel } from "./progress-panel";
import { ResultsList } from "./results-list";
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

function SearchBody(props: {
  snapshot: SearchSnapshot;
  now: Date;
  aiEnabled: boolean;
  running: boolean;
  moreActions: MoreSourceActions;
}) {
  const snapshot = props.snapshot;
  if (snapshot.results.length === 0) return null;
  const showSummary = props.aiEnabled && !props.running;
  const summaryStatus = snapshot.search.summaryStatus === "pending" ? "failed" : snapshot.search.summaryStatus;
  return (
    <div className={showSummary
      ? "mt-5 min-w-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] lg:items-start lg:gap-5"
      : "mt-5 min-w-0"}>
      {showSummary ? (
        <aside className="cari-reveal mb-5 min-w-0 lg:col-start-2 lg:row-start-1 lg:mb-0">
          <AiSummary
            ai={snapshot.ai}
            summaryStatus={summaryStatus}
            results={snapshot.results}
            comments={snapshot.comments}
            hasMoreResults={snapshot.hasMoreResults}
          />
        </aside>
      ) : null}
      <div className="cari-results min-w-0 lg:col-start-1 lg:row-start-1">
        <ResultsList
          results={snapshot.results}
          commentsByResult={commentsByResult(snapshot)}
          sortMode={snapshot.search.filters.sort}
          sources={snapshot.sources}
          moreActions={props.moreActions}
          now={props.now}
        />
        {showSummary ? (
          <div className="mt-5">
            <AskPanel
              searchId={snapshot.search.id}
              questions={snapshot.questions}
              suggestions={["Apa keluhan utama?", "Apa yang dipuji?", "Apa yang sering ditanyakan?"]}
              results={snapshot.results}
              comments={snapshot.comments}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function useStartSearch() {
  const router = useRouter();
  const phase = useRef<"idle" | "submitting" | "navigating">("idle");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => () => {
    // Next can hide this route in an Activity and restore its draft on Back.
    if (phase.current === "navigating") {
      phase.current = "idle";
      setStarting(false);
    }
  }, []);

  async function start(input: SearchFormInput) {
    if (phase.current !== "idle") return;
    phase.current = "submitting";
    setStarting(true);
    setError(null);
    try {
      const result = await startSearchAction(input);
      if (result.ok) {
        // Keep the old form locked until the route actually leaves view.
        phase.current = "navigating";
        router.push(`/cari/${result.searchId}`);
        return;
      }
      setError(ERROR_COPY[result.error] ?? "Pencarian gagal dimulai. Coba lagi.");
    } catch {
      setError("Pencarian gagal dimulai. Coba lagi.");
    }
    phase.current = "idle";
    setStarting(false);
  }

  return { start, starting, error };
}

function commentsByResult(snapshot: SearchSnapshot): Record<string, SnapshotComment[]> {
  const grouped: Record<string, SnapshotComment[]> = {};
  for (const comment of snapshot.comments) {
    grouped[comment.resultId] = [...(grouped[comment.resultId] ?? []), comment];
  }
  return grouped;
}

export function SearchDetail(props: { initialSnapshot: SearchSnapshot; now?: string; aiEnabled?: boolean }) {
  const { snapshot, stale, refresh } = useSearchPoll(
    props.initialSnapshot.search.id,
    props.initialSnapshot,
  );
  const router = useRouter();
  const now = useNow(props.now);
  const search = snapshot.search;
  const moreRequests = useRef(new Set<string>());
  const [moreBusy, setMoreBusy] = useState<string[]>([]);
  const [moreAdmitted, setMoreAdmitted] = useState<Partial<Record<string, number>>>({});
  const [moreErrors, setMoreErrors] = useState<Partial<Record<string, string>>>({});
  const moreActions: MoreSourceActions = {
    busy: (platform) => {
      const more = snapshot.sources.find((source) => source.platform === platform)?.more;
      return moreBusy.includes(platform) ||
        (more?.state === "available" && more.generation === moreAdmitted[platform]);
    },
    errors: moreErrors,
    request: (platform, generation) => void requestMore(platform, generation),
  };

  async function requestMore(platform: string, generation: number) {
    if (moreRequests.current.has(platform)) return;
    moreRequests.current.add(platform);
    setMoreBusy((sources) => [...sources, platform]);
    setMoreErrors((errors) => ({ ...errors, [platform]: undefined }));
    try {
      const result = await startMoreSourceAction(search.id, platform, generation);
      if (result.ok) {
        setMoreAdmitted((sources) => ({ ...sources, [platform]: generation }));
        refresh();
        return;
      }
      if (result.error === "unavailable") refresh();
      const message = result.error === "unavailable"
        ? "Halaman tambahan sudah tidak tersedia."
        : ERROR_COPY[result.error] ?? "Pencarian tambahan belum tersedia.";
      setMoreErrors((errors) => ({ ...errors, [platform]: message }));
    } catch {
      setMoreErrors((errors) => ({ ...errors, [platform]: "Gagal mengirim permintaan." }));
    } finally {
      moreRequests.current.delete(platform);
      setMoreBusy((sources) => sources.filter((source) => source !== platform));
    }
  }

  const detail = useRef<HTMLDivElement>(null);
  const stickySearch = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = detail.current;
    const form = stickySearch.current;
    if (!container || !form) return;
    const measure = () => container.style.setProperty(
      "--cari-search-height",
      `${form.getBoundingClientRect().height}px`,
    );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    return () => observer.disconnect();
  }, []);

  const [monitorError, setMonitorError] = useState<string | null>(null);
  const { start, starting, error } = useStartSearch();
  const running = search.status === "queued" || search.status === "running";
  const legacy = search.legacyEvidence === true;
  const aiEnabled = props.aiEnabled === true && !legacy;
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

  const rerun = (
    <button
      type="button"
      disabled={starting}
      onClick={() => void start({ query: search.query, filters: search.filters })}
      className="workspace-feedback inline-flex min-h-11 min-w-11 items-center rounded-lg border border-border px-3 font-medium text-foreground hover:bg-surface-subtle disabled:opacity-60"
    >
      {starting ? "Memulai…" : "Cari ulang"}
    </button>
  );

  return (
    <div ref={detail} className="cari-search-detail mt-5 min-w-0">
      {/* The mobile workspace header scrolls with the page. */}
      <div ref={stickySearch} className="cari-sticky-search sticky top-[env(safe-area-inset-top,0px)] z-30 mb-4">
        <SearchForm
          key={props.initialSnapshot.search.id}
          compact
          initialQuery={props.initialSnapshot.search.query}
          initialFilters={props.initialSnapshot.search.filters}
          onSubmit={start}
          pending={starting}
        />
        {error ? (
          <p role="alert" className="mt-2 rounded-lg border border-negatif/30 bg-negatif-bg px-3 py-2 text-sm text-negatif">
            {error}
          </p>
        ) : null}
      </div>
      <section className="min-w-0 rounded-xl bg-surface p-4 shadow-card sm:p-5">
        <div className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden="true" className="shrink-0 font-mono font-semibold text-primary">$</span>
          <div className="min-w-0">
            <h2 className="wrap-anywhere text-base font-semibold tracking-tight sm:text-lg">cari &quot;{search.query}&quot;</h2>
            <p className="mt-1 wrap-anywhere text-sm text-muted-foreground">{filterSummary(search.filters)}</p>
          </div>
        </div>
        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 wrap-anywhere text-sm text-muted-foreground">{receipt.join(" · ")}</p>
          {!running ? (
            <button
              type="button"
              className="workspace-feedback inline-flex min-h-11 min-w-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-surface-subtle"
              onClick={() => {
                void (async () => {
                  setMonitorError(null);
                  try {
                    const result = await monitorAsProjectAction(search.id);
                    if (result.ok) {
                      router.push(result.href);
                      return;
                    }
                    setMonitorError("Proyek belum bisa disiapkan. Coba lagi.");
                  } catch {
                    setMonitorError("Proyek belum bisa disiapkan. Coba lagi.");
                  }
                })();
              }}
            >
              Pantau sebagai proyek
            </button>
          ) : null}
        </div>
      </section>
      {monitorError ? (
        <p role="alert" className="mt-2 text-[13px] text-negatif">
          {monitorError}
        </p>
      ) : null}
      {failureCopy ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-negatif/30 bg-negatif-bg px-3 py-2 text-[13px]">
          <p role="alert" className="text-negatif">{failureCopy}</p>
          {!legacy ? rerun : null}
        </div>
      ) : null}
      {stale ? (
        <p className="mt-2 text-[12px] text-muted-foreground" role="status">
          Koneksi terputus. Menampilkan hasil terakhir.
        </p>
      ) : null}
      {legacy ? (
        <div className="mt-5 rounded-[14px] border border-border bg-surface px-5 py-4 text-[13px]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground">
              {snapshot.results.length > 0
                ? "Hasil tersimpan yang bisa diverifikasi ditampilkan di bawah. Cari ulang untuk memperbarui hasil."
                : "Tidak ada hasil tersimpan yang bisa diverifikasi. Cari ulang untuk mencari hasil terbaru."}
            </p>
            {rerun}
          </div>
        </div>
      ) : null}
      <div className="mt-5">
        <ProgressPanel key={search.id} snapshot={snapshot} now={now} aiEnabled={aiEnabled} moreActions={moreActions} />
      </div>
      {!legacy && !running && !failureCopy && snapshot.results.length === 0 ? (
        <p className="mt-5 rounded-[14px] border border-border bg-surface px-5 py-4 text-[13px] text-muted-foreground">
          Tidak ada hasil yang cocok dengan kata kunci.
        </p>
      ) : null}
      <div>
        <SearchBody key={search.id} snapshot={snapshot} now={now} aiEnabled={aiEnabled && !failureCopy} running={running} moreActions={moreActions} />
      </div>
    </div>
  );
}

export function SearchScreen(props: { history: SearchHistoryRow[]; now: string; aiEnabled?: boolean }) {
  const aiEnabled = props.aiEnabled ?? false;
  const { start, starting, error } = useStartSearch();

  async function startExample(query: string, filters: SearchFilters = DEFAULT_FILTERS) {
    await start({ query, filters });
  }

  return (
    <div className="mx-auto mt-6 min-w-0 max-w-[960px] space-y-5 md:mt-8 md:space-y-6">
      <section className="max-w-2xl">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-info">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          Hingga {LAUNCH_PLATFORMS.length} sumber · hasil dalam ±30 detik
        </span>
        <h2 className="mt-2 text-2xl font-semibold leading-tight tracking-tight text-foreground md:text-4xl">
          Apa kata orang tentang merek Anda?
        </h2>
        <p className="mt-2 max-w-xl leading-6 text-muted-foreground">
          {aiEnabled
            ? "Ketik merek, produk, atau topik. Kami mencari di media sosial dan web sekarang juga, lalu merangkum apa yang dibicarakan — lengkap dengan kutipan aslinya."
            : "Ketik merek, produk, atau topik. Kami mencari di media sosial dan web, lalu menampilkan hasilnya."}
        </p>
      </section>

      <div className="min-w-0">
        <SearchForm onSubmit={start} pending={starting} />
        {error ? (
          <p role="alert" className="mt-2 rounded-lg border border-negatif/30 bg-negatif-bg px-3 py-2 text-[13px] text-negatif">
            {error}
          </p>
        ) : null}
      </div>

      <section className="min-w-0">
        <h3 className="text-base font-semibold tracking-tight">Coba contoh pencarian</h3>
        <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          {EXAMPLE_SEARCHES.map((example, index) => (
            <button
              key={example.query}
              type="button"
              disabled={starting}
              onClick={() => void startExample(example.query)}
              className="workspace-feedback group flex min-h-11 min-w-0 items-center gap-3 rounded-xl bg-surface px-3 py-2.5 text-left shadow-card hover:bg-info-bg disabled:opacity-60"
            >
              <PlatformTile platform={LAUNCH_PLATFORMS[index] ?? "threads"} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block wrap-anywhere text-sm font-semibold text-foreground">{example.query}</span>
                <span className="block text-[12px] text-muted-foreground">{example.label}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[
            {
              icon: Search,
              title: `Cari di hingga ${LAUNCH_PLATFORMS.length} sumber`,
              body: `${LAUNCH_SOURCE_SUMMARY}. Facebook hanya mendukung tagar. Instagram dan X menggunakan indeks dengan cakupan terbatas.`,
            },
            {
              icon: MessageSquareText,
              title: "Baca komentar teratas",
              body: "Balasan pada 3 pos teratas tiap sumber ikut diambil. Kartu menampilkan 3 balasan teratas dan dapat membuka balasan lain yang tersimpan.",
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
          ].map((panel) => {
            const Icon = panel.icon;
            return (
              <div key={panel.title} className="min-w-0 rounded-xl bg-surface-subtle p-4">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-info-bg text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <h3 className="mt-3 text-[15px] font-semibold text-foreground">{panel.title}</h3>
                <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{panel.body}</p>
              </div>
            );
          })}
        </div>

      </section>
      <HistoryList rows={props.history} now={new Date(props.now)} aiEnabled={aiEnabled} recent />
    </div>
  );
}
