"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Clock, MessageSquareText, Search, Sparkles } from "lucide-react";
import { cn } from "cn";
import { formatRelative } from "@/monitor/format";
import { DEFAULT_FILTERS, type SearchFilters } from "@/monitor/search/filters";
import { startSearchAction } from "@/app/cari/actions";
import { SearchForm, EXAMPLE_SEARCHES, type SearchFormInput } from "./search-form";
import { PlatformTile } from "./platform-tile";

export type SearchHistoryRow = {
  id: string;
  query: string;
  resultCount: number;
  sourceCount: number;
  stance: string | null;
  status: string;
  createdAt: string;
};

const ERROR_COPY: Record<string, string> = {
  disabled: "Cari sekarang belum tersedia.",
  unauthenticated: "Sesi Anda berakhir. Masuk lagi untuk mencari.",
  daily_limit: "Batas pencarian hari ini sudah tercapai. Coba lagi besok.",
  invalid_query: "Kata kunci minimal 2 karakter.",
  query_too_long: "Kata kunci maksimal 160 karakter.",
};

const STANCE_STYLE: Record<string, string> = {
  positif: "bg-positif-bg text-positif",
  campuran: "bg-warning-bg text-warning",
  negatif: "bg-negatif-bg text-negatif",
  netral: "bg-netral-bg text-netral",
  faktual: "bg-info-bg text-info",
};

export function StanceChip(props: { stance: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize", STANCE_STYLE[props.stance] ?? STANCE_STYLE.netral)}>
      {props.stance}
    </span>
  );
}

function RecentSearches(props: { history: SearchHistoryRow[]; now: string }) {
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
              {row.stance ? <StanceChip stance={row.stance} /> : null}
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

export function SearchScreen(props: { history: SearchHistoryRow[]; now: string }) {
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
          8 sumber siap · hasil dalam ±30 detik
        </span>
        <h2 className="mt-5 text-[28px] font-semibold leading-tight tracking-tight text-foreground lg:text-[36px]">
          Apa kata orang tentang merek Anda?
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-[15px] leading-6 text-muted-foreground">
          Ketik merek, produk, atau topik. Kami mencari di media sosial dan web sekarang juga, lalu merangkum apa yang
          dibicarakan — lengkap dengan kutipan aslinya.
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
              <PlatformTile platform={["tiktok", "instagram", "x", "threads"][index] ?? "web"} size={32} />
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
              title: "Cari di 8 sumber",
              body: "Threads, Instagram, TikTok, YouTube, Facebook, X, Reddit, dan web — semuanya sekaligus.",
            },
            {
              icon: MessageSquareText,
              title: "Baca komentar teratas",
              body: "Balasan paling disukai ikut diambil, karena reaksi orang sering ada di komentar.",
            },
            {
              icon: Sparkles,
              title: "Dapat ringkasan AI",
              body: "Sikap per platform, kutipan asli, dan topik utama — lalu tanyakan apa saja tentang hasilnya.",
            },
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

        <RecentSearches history={props.history} now={props.now} />
      </section>
    </div>
  );
}
