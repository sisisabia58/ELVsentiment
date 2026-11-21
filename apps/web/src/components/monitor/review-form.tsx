"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { markReadAction, saveReviewAction } from "@/app/sebutan/actions";
import { formatPercent, formatWib } from "@/monitor/format";
import type { PresentedMention, Sentiment } from "@/monitor/present";
import { ISSUE_CATEGORY_LABEL, SENTIMENT_LABEL, TRIAGE_REASON_LABEL, TRIAGE_STATUS_LABEL, UNCERTAIN_LABEL } from "@/monitor/present";

export function ReviewForm(props: {
  mention: PresentedMention;
  topics: { id: string; label: string }[];
}) {
  const mention = props.mention;
  const triage = mention.triage;
  const choices: Sentiment[] = ["positive", "neutral", "negative"];
  if (mention.sentiment === "mixed") choices.push("mixed");
  const [relevance, setRelevance] = useState<"relevant" | "irrelevant" | "">(
    mention.relevance === "relevant" || mention.relevance === "irrelevant" ? mention.relevance : "",
  );
  const [sentiment, setSentiment] = useState<Sentiment | "">(mention.sentiment ?? "");
  const [topics, setTopics] = useState<string[]>(mention.topics);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const assessmentChanged =
    relevance !== (mention.relevance ?? "") ||
    (relevance === "relevant" && sentiment !== (mention.sentiment ?? ""));
  const changed = assessmentChanged || topics.join("\0") !== mention.topics.join("\0");
  const needsAssessmentChange = Boolean(triage) && mention.bucket === "not_sure" && !assessmentChanged;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (needsAssessmentChange) return;
        if (relevance !== "relevant" && relevance !== "irrelevant") {
          setError("Pilih penilaian untuk melanjutkan.");
          return;
        }
        if (relevance === "relevant" && !sentiment) {
          setError("Pilih penilaian untuk melanjutkan.");
          return;
        }
        setPending(true);
        setError(null);
        void saveReviewAction(mention.id, {
            relevance,
            sentiment: relevance === "relevant" && sentiment ? sentiment : null,
            topics: relevance === "relevant" ? topics : [],
          })
          .then((result) => {
            if (!result.ok) setError(result.error ?? "Perubahan belum tersimpan. Coba lagi.");
            else setSaved(result.action === "correct" ? "Dikoreksi oleh Anda" : "Dikonfirmasi oleh Anda");
          })
          .catch(() => setError("Perubahan belum tersimpan. Coba lagi."))
          .finally(() => setPending(false));
      }}
    >
      <p className="text-sm leading-6 text-foreground">{mention.excerpt}</p>
      {triage ? (
        <div className="space-y-2 rounded-lg bg-surface-subtle p-3 text-sm">
          {mention.corrected || mention.confirmed ? (
            <p className="font-medium">{mention.corrected ? "Dikoreksi oleh Anda" : "Dikonfirmasi oleh Anda"}</p>
          ) : null}
          {triage.origin ? (
            <p className="text-muted-foreground">
              {triage.origin === "opencode" ? "Penilaian AI" : "Pemeriksaan teks otomatis"}
              {triage.sentiment && triage.sentiment !== "unclear" ? ` · ${SENTIMENT_LABEL[triage.sentiment]}` : ""}
            </p>
          ) : (
            <p>{TRIAGE_STATUS_LABEL[triage.status]}</p>
          )}
          {triage.reason ? <p>{TRIAGE_REASON_LABEL[triage.reason]}</p> : null}
          {triage.issueCategory ? <p className="font-medium">{ISSUE_CATEGORY_LABEL[triage.issueCategory]}</p> : null}
          {triage.verifiedExcerpt ? <blockquote className="border-l-2 border-border pl-3">{triage.verifiedExcerpt}</blockquote> : null}
        </div>
      ) : null}
      {mention.uncertainFields.map((field) => (
        <p key={field} className="text-sm text-warning">
          {UNCERTAIN_LABEL[field]}
        </p>
      ))}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Relevansi</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="relevansi" checked={relevance === "relevant"} onChange={() => setRelevance("relevant")} />
          Terkait merek saya
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="relevansi" checked={relevance === "irrelevant"} onChange={() => setRelevance("irrelevant")} />
          Tidak terkait merek saya
        </label>
      </fieldset>
      {relevance === "irrelevant" ? <p className="text-sm text-muted-foreground">Sebutan ini tidak akan masuk ringkasan.</p> : null}
      {relevance === "relevant" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Sentimen</legend>
          {choices.map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" name="sentimen" checked={sentiment === value} onChange={() => setSentiment(value)} />
              {SENTIMENT_LABEL[value]}
            </label>
          ))}
        </fieldset>
      ) : null}
      {relevance === "relevant" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Topik</legend>
          {props.topics.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada topik yang dapat ditampilkan.</p>
          ) : (
            props.topics.map((topic) => (
              <label key={topic.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={topics.includes(topic.id)}
                  onChange={() =>
                    setTopics((current) =>
                      current.includes(topic.id) ? current.filter((item) => item !== topic.id) : [...current, topic.id],
                    )
                  }
                />
                {topic.label}
              </label>
            ))
          )}
        </fieldset>
      ) : null}
      {!triage && (mention.relevanceConfidence !== null ? (
        <p className="text-xs text-muted-foreground">
          Keyakinan penilaian relevansi: {formatPercent(mention.relevanceConfidence)}. Menunjukkan seberapa yakin sistem, bukan jaminan benar.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Tingkat keyakinan tidak tersedia</p>
      ))}
      {mention.sentimentConfidence !== null ? (
        <p className="text-xs text-muted-foreground">Keyakinan penilaian sentimen: {formatPercent(mention.sentimentConfidence)}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">Perubahan Anda digunakan di dasbor ini. Penilaian otomatis awal tetap disimpan.</p>
      {mention.url ? (
        <a href={mention.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary">
          Lihat postingan asli <span className="sr-only">(tab baru)</span>
        </a>
      ) : (
        <p className="text-sm">Postingan asli tidak tersedia. Penilaian yang tersimpan tetap ditampilkan.</p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-success">
          {saved}
          {mention.correctionAt ? ` · ${formatWib(mention.correctionAt)}` : ""}
        </p>
      ) : null}
      {readError ? (
        <p role="alert" className="text-sm text-danger">
          {readError}
        </p>
      ) : null}
      {needsAssessmentChange ? (
        <p className="text-sm text-muted-foreground">Ubah relevansi atau sentimen untuk menyelesaikan peninjauan.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || needsAssessmentChange} className="h-11 bg-primary text-primary-foreground">
          {changed || needsAssessmentChange ? "Simpan perubahan" : "Konfirmasi penilaian"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => {
            void markReadAction(mention.id, !mention.read).then((result) => {
              if (!result.ok) setReadError("Status dibaca belum diperbarui. Coba lagi.");
            });
          }}
        >
          {mention.read ? "Tandai belum dibaca" : "Tandai dibaca"}
        </Button>
      </div>
    </form>
  );
}
