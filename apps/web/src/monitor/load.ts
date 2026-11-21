import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import type { KeywordIntent } from "../domain/keyword-intent";
import { cariAiUiEnabled, cariSekarangEnabled } from "./search/feature";
import type { ScheduleLimits } from "../projects/schedules";
import { SCHEDULED_CAP_COPY, SCHEDULED_CAP_PARTIAL_COPY } from "../projects/dashboard-status";
import { buildDashboard, type DashboardModel, type SourceKey } from "./dashboard";
import { asSources, type SourceCredentials } from "./onboarding-draft";
import { ALL_SOURCES, loadScheduledSourceAvailability, readMonitorPolicy, reviewTopicChoices, SOURCE_NAME, type SourceId } from "./policy";
import { presentMention, type PresentedMention } from "./present";
import { readStoredMentions } from "./mention-store";
import { parseRangeKey, type RangeKey } from "./range";
import { choiceFromRow, type ScheduleChoice } from "./schedule-choice";

export type ProjectSummary = {
  id: string;
  name: string;
  initials: string;
  sources: SourceId[];
  schedule: ScheduleChoice;
  nextRunAt: string | null;
  lastCollectedAt: string | null;
  keywordCount: number;
};

export type RecordedSourceState = "ready" | "unavailable" | "authorization_failed" | "rate_limited";

export type SourceHealth = {
  source: SourceId;
  state: RecordedSourceState | "untested";
  detail: string;
  lastSuccessAt: string | null;
  configured: boolean;
};

export function resolveSourceState(
  configured: boolean,
  rowState?: RecordedSourceState | null,
): SourceHealth["state"] {
  if (!configured) return "unavailable";
  return rowState ?? "untested";
}

export type JobRow = {
  id: string;
  kind: "manual" | "scheduled";
  status: string;
  detail: string | null;
  createdAt: string;
  label: string;
  explanation: string;
};

export type Workspace = {
  email: string;
  displayName: string;
  initials: string;
  projects: ProjectSummary[];
  project: ProjectSummary | null;
  projectMissing: boolean;
  mentions: PresentedMention[];
  sources: SourceHealth[];
  jobs: JobRow[];
  pending: number;
  failed: number;
  latestStatus: string | null;
  lastCollectedAt: string | null;
  control: { manualBlocked: boolean; retryAt: string | null; lastSeenAt: string | null; inProgress: boolean };
  keywords: string[];
  keywordIntents: Record<string, KeywordIntent>;
  topicLabels: { id: string; label: string }[];
  topicCountingApproved: boolean;
  highImpact: boolean;
  credentials: SourceCredentials;
  cariEnabled?: boolean;
  cariAiEnabled?: boolean;
  isAdmin?: boolean;
};

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase("id-ID") ?? "")
    .join("");
}

function asTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function decodeKeyword(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function partialFailureExplanation(detail: string): string | null {
  const prefix = "partial_failures:";
  if (!detail.startsWith(prefix)) return null;
  const bySource = new Map<string, string[]>();
  for (const entry of detail.slice(prefix.length).split("|")) {
    const [source, rawKeyword] = entry.split(":");
    const name = SOURCE_NAME[source as SourceId];
    if (!name) continue;
    const keyword = decodeKeyword(rawKeyword ?? "").trim();
    if (!keyword) continue;
    const keywords = bySource.get(name) ?? [];
    if (!keywords.includes(keyword)) keywords.push(keyword);
    bySource.set(name, keywords);
  }
  if (bySource.size === 0) return null;
  const parts = [...bySource].map(([name, keywords]) => `${name} (kata kunci ${keywords.join(", ")})`);
  return `Pengumpulan selesai. Beberapa sumber gagal: ${parts.join(", ")}.`;
}

export function jobPresentation(status: string, detail: string | null): { label: string; explanation: string } {
  if (detail === "skipped_overlap") {
    return {
      label: "Dilewati",
      explanation: "Dilewati karena pengumpulan sebelumnya masih berjalan.",
    };
  }
  if (detail === "scheduled_request_cap") {
    return status === "succeeded"
      ? { label: "Selesai sebagian", explanation: SCHEDULED_CAP_PARTIAL_COPY }
      : { label: "Ditunda", explanation: SCHEDULED_CAP_COPY };
  }
  if (status === "succeeded") {
    const partial = detail ? partialFailureExplanation(detail) : null;
    if (partial) return { label: "Selesai", explanation: partial };
  }
  if (status === "queued") return { label: "Antri", explanation: "Menunggu giliran untuk mulai." };
  if (status === "claimed") return { label: "Berjalan", explanation: "Sedang mengumpulkan data dari sumber yang dipilih." };
  if (status === "succeeded") return { label: "Selesai", explanation: "Pengumpulan selesai. Penilaian dapat masih berlangsung." };
  if (status === "failed" || status === "deferred") {
    return { label: "Gagal", explanation: "Data belum berhasil dikumpulkan. Periksa status sumber." };
  }
  return { label: "Belum tersedia", explanation: "Status pengumpulan belum tersedia." };
}

const SOURCE_COPY: Record<SourceHealth["state"], string> = {
  ready: "Siap",
  untested: "Belum diuji",
  unavailable: "Tidak tersedia",
  authorization_failed: "Otorisasi gagal",
  rate_limited: "Dibatasi sementara",
};

export const SOURCES_UNAVAILABLE_COPY = "Sumber yang dipilih sedang tidak tersedia, kami sedang memperbaikinya.";

export function selectedSourcesReady(
  sources: readonly SourceId[],
  health: readonly SourceHealth[],
): boolean {
  return sources.some((source) => health.some((item) => item.source === source && item.configured));
}

export function sourceHealthCopy(health: SourceHealth): string {
  const name = SOURCE_NAME[health.source];
  if (!health.configured) {
    return `Sumber ${name} sedang tidak tersedia, kami sedang memperbaikinya.`;
  }
  if (health.state === "untested") {
    return `Sumber ${name} sudah dikonfigurasi dan belum diuji. Pengumpulan berikutnya akan menguji aksesnya.`;
  }
  if (health.state === "unavailable") {
    return `Sumber ${name} sedang tidak tersedia, kami sedang memperbaikinya.`;
  }
  if (health.state === "rate_limited") {
    return `Pengumpulan dari ${name} dibatasi sementara. Waktu tersedia kembali belum diketahui.`;
  }
  if (health.state === "authorization_failed") return "Otorisasi sumber gagal. Akses sumber dikelola oleh kami.";
  return SOURCE_COPY[health.state];
}

export async function loadWorkspace(
  db: Queryable,
  customerId: string,
  requestedProjectId: string | undefined,
  now: Date,
  limits: ScheduleLimits,
  isAdmin = false,
): Promise<Workspace> {
  const policy = readMonitorPolicy();
  return withCustomer(db, customerId, async () => {
    const credentials = await loadScheduledSourceAvailability(db);
    const user = await db.query<{ email: string; display_name: string | null }>(
      "select email, display_name from users where customer_id = $1 order by created_at limit 1",
      [customerId],
    );
    const account = user.rows[0];
    const displayName = account?.display_name?.trim() || account?.email || "Pemilik";
    const cariEnabled = cariSekarangEnabled();
    const cariAiEnabled = cariAiUiEnabled();
    const projectRows = await db.query<{
      id: string;
      brand_name: string;
      enabled_sources: unknown;
      enabled: boolean | null;
      interval_hours: number | null;
      cadence: string | null;
      daily_minute: number | null;
      next_run_at: string | Date | null;
      last_collected_at: string | Date | null;
      keyword_count: number | string;
    }>(
      `select p.id, p.brand_name, s.enabled_sources,
              sch.enabled, sch.interval_hours, sch.cadence, sch.daily_minute, sch.next_run_at, sch.last_collected_at,
              (select count(*) from keyword_variants k where k.project_id = p.id and k.active) as keyword_count
       from projects p
       left join project_settings s on s.project_id = p.id
       left join project_schedules sch on sch.project_id = p.id
       order by p.created_at desc, p.id`,
    );
    const projects: ProjectSummary[] = projectRows.rows.map((row) => {
      const sources = asSources(asTextArray(row.enabled_sources));
      return {
        id: row.id,
        name: row.brand_name,
        initials: initials(row.brand_name),
        sources: sources.length > 0 ? sources : [...ALL_SOURCES],
        schedule: choiceFromRow({
          enabled: row.enabled === true,
          intervalHours: row.interval_hours ?? 6,
          cadence: row.cadence,
          dailyMinute: row.daily_minute,
        }),
        nextRunAt: iso(row.next_run_at),
        lastCollectedAt: iso(row.last_collected_at),
        keywordCount: Number(row.keyword_count ?? 0),
      };
    });
    const requested = requestedProjectId?.trim() ?? "";
    const matched = requested ? (projects.find((item) => item.id === requested) ?? null) : (projects[0] ?? null);
    const projectMissing = requested.length > 0 && matched === null;
    const project = matched;
    if (!project) {
      return {
        email: account?.email ?? "",
        displayName,
        initials: initials(displayName),
        projects,
        project: null,
        projectMissing,
        mentions: [],
        sources: [],
        jobs: [],
        pending: 0,
        failed: 0,
        latestStatus: null,
        lastCollectedAt: null,
        control: { manualBlocked: false, retryAt: null, lastSeenAt: null, inProgress: false },
        keywords: [],
        keywordIntents: {},
        topicLabels: reviewTopicChoices(policy),
        topicCountingApproved: policy.topicCountingApproved,
        highImpact: policy.highImpact,
        credentials,
        cariEnabled,
        cariAiEnabled,
        isAdmin,
      };
    }
    const mentions = (await readStoredMentions(db, customerId, { projectId: project.id }))
      .map((row) => presentMention(row, policy.scoring));
    const keywordRows = await db.query<{ text: string; intent: KeywordIntent }>(
      "select text, intent from keyword_variants where project_id = $1 and active order by created_at, text",
      [project.id],
    );
    const statusRows = await db.query<{
      source: SourceId;
      state: RecordedSourceState;
      detail: string;
      last_success_at: string | Date | null;
    }>("select source, state, detail, last_success_at from source_status where project_id = $1", [project.id]);
    const recorded = new Map(statusRows.rows.map((row) => [row.source, row]));
    const sources: SourceHealth[] = ALL_SOURCES.map((source) => {
      const row = recorded.get(source);
      const configured = Boolean(credentials[source]);
      const state = resolveSourceState(configured, row?.state ?? null);
      return {
        source,
        state,
        detail: row?.detail ?? "",
        lastSuccessAt: iso(row?.last_success_at),
        configured,
      };
    });
    const jobRows = await db.query<{
      id: string;
      kind: "manual" | "scheduled";
      status: string;
      status_detail: string | null;
      created_at: string | Date;
    }>(
      `select id, kind, status, status_detail, created_at from jobs
       where project_id = $1
       order by created_at desc, id desc
       limit 50`,
      [project.id],
    );
    const jobs: JobRow[] = jobRows.rows.map((row) => {
      const presentation = jobPresentation(row.status, row.status_detail);
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        detail: row.status_detail,
        createdAt: iso(row.created_at) ?? "",
        label: presentation.label,
        explanation: presentation.explanation,
      };
    });
    const latest = jobs.find((job) => job.detail !== "skipped_overlap") ?? null;
    const beat = await db.query<{ last_seen_at: string | Date }>("select last_seen_at from worker_heartbeat where id = 1");
    const active = await db.query<{ id: string }>(
      "select id from jobs where project_id = $1 and status in ('queued', 'claimed') limit 1",
      [project.id],
    );
    const recent = await db.query<{ created_at: string | Date }>(
      `select created_at from jobs
       where project_id = $1 and kind = 'manual' and status <> 'deferred'
       order by created_at desc limit 1`,
      [project.id],
    );
    const lastManual = iso(recent.rows[0]?.created_at);
    const retryAt = lastManual ? new Date(new Date(lastManual).getTime() + limits.manualMinIntervalSeconds * 1000) : null;
    const manualBlocked = retryAt !== null && retryAt > now;
    return {
      email: account?.email ?? "",
      displayName,
      initials: initials(displayName),
      projects,
      project,
      projectMissing,
      mentions,
      sources,
      jobs,
      pending: mentions.filter((mention) => mention.scoringStatus === "pending" || mention.scoringStatus === "scoring").length,
      failed: mentions.filter((mention) => mention.scoringStatus === "failed").length,
      latestStatus: latest?.status ?? null,
      lastCollectedAt: project.lastCollectedAt,
      control: {
        manualBlocked,
        retryAt: manualBlocked && retryAt ? retryAt.toISOString() : null,
        lastSeenAt: iso(beat.rows[0]?.last_seen_at),
        inProgress: active.rows.length > 0,
      },
      keywords: keywordRows.rows.map((row) => row.text),
      keywordIntents: Object.fromEntries(keywordRows.rows.map((row) => [row.text, row.intent])),
      topicLabels: reviewTopicChoices(policy),
      topicCountingApproved: policy.topicCountingApproved,
      highImpact: policy.highImpact,
      credentials,
      cariEnabled,
      cariAiEnabled,
      isAdmin,
    };
  });
}

export function dashboardFor(workspace: Workspace, rangeValue: string | undefined, sourceValue: string | undefined, now: Date): DashboardModel {
  const range: RangeKey = parseRangeKey(rangeValue);
  const source: SourceKey =
    sourceValue === "x" || sourceValue === "threads" || sourceValue === "instagram" || sourceValue === "tiktok"
      ? sourceValue
      : "all";
  const mentions = workspace.mentions;
  return buildDashboard({
    mentions,
    range,
    source,
    now,
    attentionUnread: mentions.filter((mention) => mention.attentionUnread).length,
    uncertainOpen: mentions.filter((mention) => mention.bucket === "not_sure" && !mention.confirmed && !mention.corrected).length,
    partial: workspace.sources.some(
      (item) =>
        !item.configured ||
        item.state === "unavailable" ||
        item.state === "authorization_failed" ||
        item.state === "rate_limited",
    ),
  });
}
