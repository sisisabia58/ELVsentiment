"use client";

import { useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { keywordLabel, parseKeyword, requestCount, type Keyword, type KeywordIntent } from "@/domain/keyword-intent";
import { normalizeVariant } from "@/domain/variants";
import { workingSources, type SourceCredentials, type SourceId } from "@/monitor/onboarding-draft";
import type { ScheduleChoice } from "@/monitor/schedule-choice";
import { saveProjectSettingsAction } from "@/app/proyek/actions";
import { Panel } from "./bits";
import { ScheduleFields } from "./schedule-fields";
import { SourceChoices } from "./source-choices";

export function SettingsForm(props: {
  projectId: string;
  brandName: string;
  keywords: string[];
  keywordIntents?: Record<string, KeywordIntent>;
  sources: SourceId[];
  schedule: ScheduleChoice;
  credentials: SourceCredentials;
}) {
  const [brand, setBrand] = useState(props.brandName);
  const [keywords, setKeywords] = useState<Keyword[]>(() =>
    props.keywords.map((text) => ({
      text,
      intent: props.keywordIntents?.[text] ?? parseKeyword(text).intent,
    })),
  );
  const [draft, setDraft] = useState("");
  const [sources, setSources] = useState(workingSources(props.sources, props.credentials));
  const [schedule, setSchedule] = useState(props.schedule);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="mt-6 flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setMessage(null);
        void saveProjectSettingsAction({
          projectId: props.projectId,
          brandName: brand,
          variants: keywords,
          sources: workingSources(sources, props.credentials),
          schedule,
        }).then((result) => {
          setPending(false);
          if (result.ok) setMessage(result.message);
          else setError(result.error);
        });
      }}
    >
      <Panel title="Nama merek" subtitle="Nama yang Anda gunakan untuk mengenali proyek ini.">
        <label className="block text-sm">
          <span className="sr-only">Nama merek</span>
          <input value={brand} onChange={(event) => setBrand(event.target.value)} aria-label="Nama merek" className="h-11 w-full max-w-md rounded-lg border border-input-border bg-surface px-3 text-sm" />
        </label>
      </Panel>
      <Panel title="Variasi kata kunci" subtitle="Semua ejaan dan sebutan merek yang ingin kami pantau.">
        <ul className="flex flex-wrap gap-2">
          {keywords.map((keyword) => (
            <li key={keyword.text}>
              <button
                type="button"
                className="inline-flex h-11 max-w-full items-center break-all rounded-full bg-info-bg px-3 text-sm text-primary"
                onClick={() => setKeywords((current) => current.filter((item) => item.text !== keyword.text))}
              >
                <span>{keywordLabel(keyword.intent)}: {keyword.text}</span> <span className="sr-only">hapus</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex min-w-0 max-w-full gap-2">
          <input aria-label="Variasi kata kunci" value={draft} onChange={(event) => setDraft(event.target.value)} className="h-11 w-0 min-w-0 flex-1 rounded-lg border border-input-border px-3 text-sm" />
          <button
            type="button"
            className="h-11 shrink-0 rounded-lg border border-border px-3 text-sm font-medium"
            onClick={() => {
              const parsed = parseKeyword(draft);
              const text = normalizeVariant(parsed.text);
              const duplicate = keywords.some((keyword) => keyword.text === text);
              if (!text || duplicate) {
                setError(duplicate ? "Variasi ini sudah ditambahkan." : "Masukkan variasi kata kunci.");
                return;
              }
              setKeywords((current) => [...current, { text, intent: parsed.intent }]);
              setDraft("");
              setError(null);
            }}
          >
            Tambahkan
          </button>
        </div>
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p className="text-sm tabular-nums text-foreground">
            hingga {requestCount(keywords, workingSources(sources, props.credentials))} permintaan per pengumpulan
          </p>
          <p>Jumlah ini adalah batas atas kata kunci × rute; kredit hanya ditampilkan bila penyedia melaporkannya.</p>
          <p>Threads tidak punya pencarian tagar; tagar dicari sebagai teks.</p>
          <p>Instagram frasa mencari reel dan tagar gabungan; tagar memakai pencarian tagar.</p>
          <p>Halaman kedua Instagram tagar hanya diambil bila halaman pertama mayoritas cocok literal.</p>
        </div>
      </Panel>
      <Panel title="Sumber" subtitle="Platform yang kami pantau untuk proyek ini.">
        <SourceChoices credentials={props.credentials} selected={sources} onChange={setSources} />
        <p className="mt-2 text-xs text-muted-foreground">Akses sumber dikelola oleh kami. Anda tidak perlu menghubungkan akun.</p>
      </Panel>
      <Panel title="Jadwal pengumpulan" subtitle="Atur seberapa sering kami mengambil sebutan baru untuk proyek ini.">
        <ScheduleFields value={schedule} onChange={setSchedule} />
      </Panel>
      <p className="flex items-start gap-1.5 text-[13px] leading-5 text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Perubahan berlaku untuk pengumpulan berikutnya. Data dan penilaian sebelumnya tidak diubah.
      </p>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm">{message}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={pending} className="h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
          Simpan perubahan
        </button>
        <Link href="/proyek" className="inline-flex h-11 items-center text-sm font-medium text-primary">
          Kembali ke Proyek
        </Link>
      </div>
    </form>
  );
}
