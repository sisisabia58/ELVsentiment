"use client";

import { useEffect, useState } from "react";
import { askQuestionAction, retryQuestionAction } from "@/app/cari/start-action";
import type { SnapshotComment, SnapshotQuestion, SnapshotResult } from "@/monitor/search/load";
import { EvidenceLinks } from "./evidence-links";
import { evidenceSources, resolveEvidence } from "./quote-source";

const ERROR_COPY: Record<string, string> = {
  invalid_question: "Pertanyaan 3–300 karakter.",
  disabled: "Pertanyaan belum tersedia.",
  not_found: "Pencarian tidak ditemukan.",
  no_evidence: "Pertanyaan memerlukan hasil yang cocok. Coba cari ulang.",
  unauthenticated: "Masuk dulu untuk bertanya.",
};

const FAILURE_COPY: Record<string, string> = {
  http_429: "Kuota AI sedang penuh. Coba lagi sebentar lagi.",
  paused: "Kuota AI sedang dijeda. Coba lagi sebentar lagi.",
  cycle_cap: "Terlalu banyak permintaan sekaligus. Coba lagi sebentar lagi.",
  http_4xx: "AI menolak permintaan jawaban.",
  http_5xx: "AI sedang gangguan. Coba lagi sebentar lagi.",
  http_503: "AI sedang sibuk. Coba lagi sebentar lagi.",
  http_504: "AI sedang sibuk. Coba lagi sebentar lagi.",
  timeout: "Jawaban terlalu lama. Coba lagi.",
  empty_answer: "Bukti yang tersedia belum cukup untuk menjawab.",
  no_evidence: "Pertanyaan memerlukan hasil yang cocok. Coba cari ulang.",
  missing_key: "Kunci AI belum diatur.",
  config_error: "Konfigurasi AI ditolak. Periksa kunci API.",
  malformed_json: "Jawaban AI tidak bisa dibaca.",
  transport_error: "AI tidak terjangkau. Coba lagi.",
  error: "Jawaban gagal. Coba lagi.",
};

function failureCopy(detail: string | null | undefined): string {
  if (detail && FAILURE_COPY[detail]) return FAILURE_COPY[detail];
  if (detail && /^http_5\d\d$/.test(detail)) return FAILURE_COPY.http_5xx;
  if (detail && /^http_\d{3}$/.test(detail)) return `Jawaban gagal (${detail}). Coba lagi.`;
  return "Jawaban gagal. Coba lagi.";
}

export function AskPanel(props: {
  searchId: string;
  questions: SnapshotQuestion[];
  suggestions: string[];
  results?: SnapshotResult[];
  comments?: SnapshotComment[];
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState(props.questions);
  const [source, setSource] = useState(props.questions);
  if (props.questions !== source) {
    setSource(props.questions);
    setItems(props.questions);
  }
  const waiting = items.some((item) => item.status === "queued" || item.status === "running");

  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch(`/api/cari/${encodeURIComponent(props.searchId)}`, { cache: "no-store" });
        if (!response.ok) return;
        const snapshot = (await response.json()) as { questions?: SnapshotQuestion[] };
        if (!cancelled && Array.isArray(snapshot.questions)) setItems(snapshot.questions);
      } catch {
        // Keep the last stored questions. A poll miss is not a failed answer.
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [props.searchId, waiting]);

  async function submit(question: string) {
    const value = question.trim();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await askQuestionAction(props.searchId, value);
      if (!result.ok) {
        setError(ERROR_COPY[result.error] ?? "Pertanyaan gagal dikirim. Coba lagi.");
        return;
      }
      setText("");
      setItems((current) => [
        ...current,
        {
          id: result.questionId,
          question: value,
          status: "queued",
          answer: null,
          citations: [],
          safeDetail: null,
          createdAt: new Date().toISOString(),
          answeredAt: null,
        },
      ]);
    } catch {
      setError("Pertanyaan gagal dikirim. Coba lagi.");
    } finally {
      setPending(false);
    }
  }

  async function retry(item: SnapshotQuestion) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await retryQuestionAction(props.searchId, item.id);
      if (!result.ok) {
        setError(ERROR_COPY[result.error] ?? "Pertanyaan gagal dikirim. Coba lagi.");
        return;
      }
      setItems((current) =>
        current.map((row) =>
          row.id === item.id ? { ...row, status: "queued", answer: null, safeDetail: null, answeredAt: null } : row,
        ),
      );
    } catch {
      setError("Pertanyaan gagal dikirim. Coba lagi.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card">
      <h2 className="text-[15px] font-semibold text-foreground">Tanya hasil ini</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        1 kredit per pertanyaan. Jawaban merujuk pada cuplikan unggahan dan balasan yang relevan.
      </p>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(text);
        }}
      >
        <label className="text-[12px] font-medium text-foreground" htmlFor={`pertanyaan-${props.searchId}`}>
          Pertanyaan
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`pertanyaan-${props.searchId}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[14px] text-foreground"
          />
          <button
            type="submit"
            disabled={pending}
            className="h-11 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-foreground disabled:opacity-60"
          >
            Kirim
          </button>
        </div>
      </form>
      {props.suggestions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {props.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="rounded-full border border-border px-3 py-1 text-[12px] text-foreground"
              onClick={() => setText(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-negatif">
          {error}
        </p>
      ) : null}
      <ul className="mt-4 space-y-3">
        {items.map((item) => {
          const sample = evidenceSources(item.evidenceIds, props.results ?? [], props.comments ?? []);
          const sources = resolveEvidence(item.citations, sample);
          const failed = item.status === "failed";
          const open = item.status === "queued" || item.status === "running";
          return (
            <li key={item.id} className="rounded-lg border border-border px-3 py-3">
              <p className="text-[13px] font-medium text-foreground">{item.question}</p>
              {open ? <p className="mt-1 text-[12.5px] text-muted-foreground">Menjawab…</p> : null}
              {failed ? (
                <div className="mt-2">
                  <p className="text-[13px] text-muted-foreground">{failureCopy(item.safeDetail)}</p>
                  <button
                    type="button"
                    className="mt-2 text-[12.5px] font-medium text-primary"
                    onClick={() => void retry(item)}
                  >
                    Coba lagi
                  </button>
                </div>
              ) : null}
              {item.status === "done" ? (
                <div className="mt-2">
                  {item.answer && sources.length ? (
                    <>
                      <p className="text-[13.5px] leading-6 text-foreground">{item.answer}</p>
                      <EvidenceLinks sources={sources} label="Sumber jawaban" />
                    </>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">Jawaban belum tersedia dengan sumber yang dapat diperiksa.</p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
