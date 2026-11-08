import type { Queryable } from "../db/migrate";
import { ALL_SOURCES, SOURCE_NAME, type SourceId } from "../monitor/policy";

export type LatestJobStatus = "queued" | "claimed" | "succeeded" | "deferred" | "failed";
export type CollectionOutcome = "none" | "failed" | "succeeded" | "queued" | "claimed";

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

export function formatCollectedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const month = MONTHS[Number(get("month")) - 1] ?? get("month");
  const hour = get("hour").replace(/\D/g, "").padStart(2, "0");
  const minute = get("minute").replace(/\D/g, "").padStart(2, "0");
  return `${Number(get("day"))} ${month} ${get("year")}, ${hour}.${minute} WIB`;
}

export function collectionOutcome(input: {
  hasProject: boolean;
  latestStatus: LatestJobStatus | null;
}): CollectionOutcome {
  if (!input.hasProject || input.latestStatus == null) return "none";
  if (input.latestStatus === "failed" || input.latestStatus === "deferred") return "failed";
  if (input.latestStatus === "succeeded") return "succeeded";
  if (input.latestStatus === "queued") return "queued";
  return "claimed";
}

export function collectionSentence(outcome: CollectionOutcome, lastSuccess: string): string {
  if (outcome === "failed") return "Pengumpulan gagal. Ini bukan nol sebutan.";
  if (outcome === "queued") return "Pekerjaan masuk antrean.";
  if (outcome === "claimed") return "Pengumpulan sedang berjalan.";
  if (outcome === "succeeded") {
    const when = lastSuccess.trim();
    return when === "" ? "Pengumpulan terakhir berhasil" : `Pengumpulan terakhir berhasil ${formatCollectedAt(when)}`;
  }
  return "Belum ada pengumpulan data";
}

const STATE_LABEL: Record<string, string> = {
  ready: "Siap",
  untested: "Belum diuji",
  unavailable: "Tidak tersedia",
  authorization_failed: "Otorisasi gagal",
  rate_limited: "Batas permintaan tercapai",
};

const SOURCE_LABEL: Record<string, string> = SOURCE_NAME;

export function sourceStateSummary(rows: { source: string; state: string }[]): string {
  if (rows.length === 0) return "Status sumber belum tercatat.";
  const order = (source: string) => {
    const index = ALL_SOURCES.indexOf(source as SourceId);
    return index === -1 ? ALL_SOURCES.length : index;
  };
  return [...rows]
    .sort((left, right) => order(left.source) - order(right.source))
    .map((row) => `Status ${SOURCE_LABEL[row.source] ?? row.source}: ${STATE_LABEL[row.state] ?? row.state}`)
    .join(". ");
}

function asIso(value: string | Date | null | undefined): string {
  if (value == null) return "";
  return value instanceof Date ? value.toISOString() : value;
}

export async function readProjectCollection(
  db: Queryable,
  projectId: string,
): Promise<{
  latestStatus: LatestJobStatus | null;
  lastCollectedAt: string;
  pending: number;
  failed: number;
  sourceState: string;
}> {
  const schedule = await db.query<{ last_collected_at: string | Date | null }>(
    "select last_collected_at from project_schedules where project_id = $1",
    [projectId],
  );
  const latest = await db.query<{ status: LatestJobStatus }>(
    `select status from jobs
     where project_id = $1 and coalesce(status_detail, '') <> 'skipped_overlap'
     order by created_at desc, id desc
     limit 1`,
    [projectId],
  );
  const scores = await db.query<{ pending: number | string; failed: number | string }>(
    `select count(*) filter (where scoring_status in ('pending', 'scoring'))::int as pending,
            count(*) filter (where scoring_status = 'failed')::int as failed
     from mentions
     where project_id = $1`,
    [projectId],
  );
  const sources = await db.query<{ source: string; state: string }>(
    "select source, state from source_status where project_id = $1",
    [projectId],
  );
  return {
    latestStatus: latest.rows[0]?.status ?? null,
    lastCollectedAt: asIso(schedule.rows[0]?.last_collected_at),
    pending: Number(scores.rows[0]?.pending ?? 0),
    failed: Number(scores.rows[0]?.failed ?? 0),
    sourceState: sourceStateSummary(sources.rows),
  };
}
