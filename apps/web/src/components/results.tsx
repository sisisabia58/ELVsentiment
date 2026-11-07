import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { scoringFailureCopy } from "@/monitor/copy";
import { SOURCE_NAME, type SourceId } from "@/monitor/policy";
import { collectionSentence, type CollectionOutcome } from "@/projects/dashboard-status";

const SENTIMENT_TEXT = { positive: "Positif", neutral: "Netral", negative: "Negatif" } as const;

function Panel(props: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base leading-snug font-medium">{props.title}</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">{props.children}</CardContent>
    </Card>
  );
}

function sourceStateText(state: string): string {
  return state.trim() === "Tidak tersedia" ? "Status sumber: Tidak tersedia" : state;
}

export function withFilters(path: string, filters: { from?: string; to?: string; source?: string }): string {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.source) params.set("source", filters.source);
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

export function OverviewPanel(props: {
  score: { kind: "empty" } | { kind: "score"; value: number; included: number };
  included: number;
  formulaApproved: boolean;
  from: string;
  to: string;
}) {
  return (
    <Panel title="Skor sentimen">
      {props.from === "" || props.to === "" ? <p>Pilih rentang tanggal.</p> : null}
      {props.score.kind === "empty" ? (
        <p>Belum ada sebutan yang dinilai</p>
      ) : (
        <>
          <p>{props.score.value}</p>
          <p>{props.score.included} sebutan dihitung</p>
          <p>
            Skor = 100 × (positif − negatif) / semua sebutan yang dihitung. Rentangnya −100 sampai +100. Ini bukan tingkat keyakinan penilaian otomatis.
          </p>
          {props.formulaApproved ? null : <p>Rumus ini menunggu persetujuan.</p>}
        </>
      )}
    </Panel>
  );
}

export function TrendPanel(props: {
  timeZone: string | null;
  bucket: "day" | "week" | null;
  rows: { createdAt: string; sentiment: "positive" | "neutral" | "negative" }[];
  buckets: { bucketStart: string; positive: number; neutral: number; negative: number }[];
}) {
  if (!props.timeZone || !props.bucket) {
    return (
      <Panel title="Tren">
        <p>Pilih zona waktu dan ukuran kelompok sebelum grafik ditampilkan.</p>
        <table>
          <tbody>
            {props.rows.map((row) => (
              <tr key={`${row.createdAt}-${row.sentiment}`}>
                <td>{row.createdAt}</td>
                <td>{SENTIMENT_TEXT[row.sentiment]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    );
  }
  return (
    <Panel title="Tren">
      <table>
        <tbody>
          {props.buckets.map((bucket) => (
            <tr key={bucket.bucketStart}>
              <td>{bucket.bucketStart}</td>
              <td>{bucket.positive}</td>
              <td>{bucket.neutral}</td>
              <td>{bucket.negative}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function TopicPanel(props: { counts: { label: string; count: number }[]; countingApproved: boolean }) {
  return (
    <Panel title="Topik teratas">
      {props.countingApproved ? (
        <p>Satu sebutan bisa masuk ke beberapa topik.</p>
      ) : (
        <p>Ringkasan topik akan tersedia segera.</p>
      )}
      <ul>
        {props.counts.map((count) => (
          <li key={count.label}>
            {count.label} {count.count}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

type MentionRow = {
  id: string;
  excerpt: string;
  source: SourceId;
  url: string;
  postedAt: string;
  relevance: "relevant" | "irrelevant" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
  confidence: number | null;
  displaySource: "failed" | "owner_confirm" | "owner_correct" | "jev";
  scoringStatus: "pending" | "scoring" | "succeeded" | "failed";
  sourcePostUnavailable: boolean;
};

function mentionStatus(row: MentionRow): string {
  if (row.sourcePostUnavailable) return "Postingan tidak lagi tersedia";
  if (row.displaySource === "failed" || row.scoringStatus === "failed") return "Penilaian gagal";
  if (row.scoringStatus === "pending" || row.scoringStatus === "scoring") return "Penilaian tertunda";
  if (row.displaySource === "owner_confirm" || row.displaySource === "owner_correct") return "Koreksi pemilik";
  return "Penilaian otomatis";
}

export function MentionFeed(props: { mentions: MentionRow[] }) {
  return (
    <Panel title="Sebutan">
      {props.mentions.length === 0 ? (
        <p>Belum ada sebutan.</p>
      ) : (
        <ul>
          {props.mentions.map((mention) => (
            <li key={mention.id}>
              <p>{mention.excerpt}</p>
              <p>{SOURCE_NAME[mention.source]}</p>
              <p>{mention.postedAt}</p>
              <p>{mentionStatus(mention)}</p>
              {mention.relevance === "relevant" ? <p>Relevan</p> : mention.relevance === "irrelevant" ? <p>Tidak relevan</p> : null}
              {mention.sentiment ? <p>{SENTIMENT_TEXT[mention.sentiment]}</p> : null}
              <p>{mention.topics.join(", ")}</p>
              {typeof mention.confidence === "number" ? (
                <p>
                  <span>Seberapa yakin</span> <span>{String(mention.confidence)}</span>
                </p>
              ) : null}
              <a href={mention.url}>Buka sumber</a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function DataStatusPanel(props: {
  outcome: CollectionOutcome;
  lastSuccess: string;
  pending: number;
  failed: number;
  sourceState: string;
}) {
  return (
    <Panel title="Status data">
      <p>{collectionSentence(props.outcome, props.lastSuccess)}</p>
      <p>Penilaian tertunda {props.pending}</p>
      {scoringFailureCopy(props.failed) ? <p>{scoringFailureCopy(props.failed)}</p> : null}
      <p>{sourceStateText(props.sourceState)}</p>
      <p>Nilai keyakinan adalah ketidakpastian model, bukan jaminan kebenaran.</p>
    </Panel>
  );
}
