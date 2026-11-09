import Link from "next/link";
import { LogoutForm } from "@/components/logout-form";
import { formatRelative, formatWib, formatWibClock } from "@/monitor/format";
import { projectHref } from "@/monitor/links";
import { selectedSourcesReady, type Workspace } from "@/monitor/load";
import type { PresentedMention, Sentiment } from "@/monitor/present";
import { SENTIMENT_LABEL, UNCERTAIN_LABEL } from "@/monitor/present";
import { mentionInWindow, parseRangeKey, rangeWindow } from "@/monitor/range";
import { TEXT_MATCH_LABEL, textMatchCounts } from "@/monitor/relevance";
import { emptyCollectionBody } from "@/monitor/copy";
import { EmptyState, PageHeader, Panel, SentimentTag, SourceMark } from "./bits";
import { ReviewForm } from "./review-form";
import { Frame } from "./shell";
import { TextMatchSummary } from "./text-match-summary";

const PAGE_SIZE = 10;

export function MentionsScreen(props: {
  workspace: Workspace;
  now: string;
  mode: "sebutan" | "perlu-perhatian" | "belum-yakin";
  page: number;
  range: string;
  source: string;
  sentiment?: string;
  query: string;
  reviewId?: string;
}) {
  const projectId = props.workspace.project?.id ?? null;
  const rangeKey = parseRangeKey(props.range);
  const window = rangeWindow(rangeKey, new Date(props.now));
  const sentiment = props.sentiment === "positive" || props.sentiment === "neutral" || props.sentiment === "negative" ? props.sentiment : "";
  const rows = rowsFor(props.workspace, props.mode, props.source, sentiment, window.start, window.end);
  const searched = props.query
    ? rows.filter((row) => row.excerpt.toLocaleLowerCase("id-ID").includes(props.query.toLocaleLowerCase("id-ID")))
    : rows;
  const totalPages = Math.max(1, Math.ceil(searched.length / PAGE_SIZE));
  const page = Math.min(props.page, totalPages);
  const slice = searched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const review = props.reviewId ? props.workspace.mentions.find((mention) => mention.id === props.reviewId) ?? null : null;
  const textMatch = textMatchCounts(searched);
  const missingReview = Boolean(props.reviewId) && !review;
  const filtersActive = Boolean(props.query) || Boolean(props.source) || Boolean(sentiment) || rangeKey !== "7";
  const listHref = projectHref(pathFor(props.mode), projectId, {
    rentang: rangeKey,
    sumber: props.source || undefined,
    sentimen: sentiment || undefined,
    q: props.query || undefined,
    halaman: page > 1 ? String(page) : undefined,
  });
  const title = props.mode === "sebutan" ? "Sebutan" : props.mode === "perlu-perhatian" ? "Perlu perhatian" : "Belum yakin";
  const subtitle =
    props.mode === "sebutan"
      ? "Semua sebutan yang tersimpan untuk proyek ini."
      : props.mode === "perlu-perhatian"
        ? "Sebutan yang mungkin perlu Anda periksa. Semua pemberitahuan tersedia di dasbor ini."
        : "Periksa penilaian yang masih belum pasti sebelum dimasukkan ke ringkasan.";
  const noData = props.workspace.mentions.length === 0 && props.workspace.jobs.length === 0;
  const runAvailable = props.workspace.project
    ? selectedSourcesReady(props.workspace.project.sources, props.workspace.sources)
    : false;
  const emptyCopy = noData
    ? { title: "Belum ada data.", body: emptyCollectionBody(runAvailable) }
    : props.mode === "perlu-perhatian"
      ? { title: "Tidak ada sebutan yang perlu perhatian dalam filter ini.", body: "Ubah filter atau tunggu pengumpulan berikutnya." }
      : props.mode === "belum-yakin"
        ? { title: "Tidak ada penilaian yang perlu diperiksa dalam filter ini.", body: "Penilaian yang belum pasti akan muncul di sini." }
        : searched.length === 0 && rows.length > 0
          ? { title: "Tidak ada sebutan yang sesuai dengan filter ini.", body: "Hapus filter untuk melihat sebutan lain." }
          : { title: "Belum ada sebutan yang ditemukan pada rentang ini.", body: "Ubah rentang tanggal atau jalankan pengumpulan." };

  return (
    <Frame active={props.mode === "sebutan" ? "/sebutan" : props.mode === "perlu-perhatian" ? "/perlu-perhatian" : "/belum-yakin"} workspace={props.workspace} logout={<LogoutForm />}>
      <PageHeader title={title} subtitle={props.workspace.project ? subtitle : "Belum ada proyek. Tambahkan merek untuk mulai memantau."} />
      {props.workspace.projectMissing ? (
        <div className="mt-5">
          <EmptyState
            title="Halaman tidak ditemukan atau Anda tidak memiliki akses."
            body="Kembali ke dasbor untuk membuka proyek Anda."
            action={<Link href="/dasbor" className="text-sm font-medium text-primary">Kembali ke dasbor</Link>}
          />
        </div>
      ) : !props.workspace.project ? (
        <div className="mt-5">
          <EmptyState title="Belum ada proyek." body="Tambahkan merek untuk mulai memantau." action={<Link href="/onboarding" className="text-sm font-medium text-primary">Buat proyek</Link>} />
        </div>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className={`flex flex-col gap-4 ${review ? "hidden lg:flex" : ""}`}>
            <FilterBar
              mode={props.mode}
              projectId={projectId}
              rangeKey={rangeKey}
              source={props.source}
              sentiment={sentiment}
              query={props.query}
              filtersActive={filtersActive}
            />
            {slice.length === 0 ? (
              <EmptyState title={emptyCopy.title} body={emptyCopy.body} />
            ) : (
              <Panel>
                <TextMatchSummary counts={textMatch} />
                <ul className="divide-y divide-border">
                  {slice.map((mention) => (
                    <li key={mention.id} className="py-3">
                      <MentionLine
                        mention={mention}
                        now={props.now}
                        href={projectHref(pathFor(props.mode), projectId, {
                          tinjau: mention.id,
                          rentang: rangeKey,
                          sumber: props.source || undefined,
                          sentimen: sentiment || undefined,
                          q: props.query || undefined,
                        })}
                        mode={props.mode}
                      />
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted-foreground">
                  {searched.length === 0 ? "0" : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, searched.length)}`} dari {searched.length} sebutan
                </p>
                {totalPages > 1 ? (
                  <div className="mt-3 flex gap-3 text-sm">
                    {page > 1 ? (
                      <Link href={projectHref(pathFor(props.mode), projectId, { ...filterParams(props, rangeKey, sentiment), halaman: String(page - 1) })} className="font-medium text-primary">
                        Sebelumnya
                      </Link>
                    ) : null}
                    {page < totalPages ? (
                      <Link href={projectHref(pathFor(props.mode), projectId, { ...filterParams(props, rangeKey, sentiment), halaman: String(page + 1) })} className="font-medium text-primary">
                        Berikutnya
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </Panel>
            )}
          </div>
          {missingReview ? (
            <EmptyState title="Sebutan tidak ditemukan." body="Tautan ini tidak cocok dengan sebutan pada proyek ini." action={<Link href={listHref} className="text-sm font-medium text-primary">Kembali ke daftar</Link>} />
          ) : null}
          {review ? (
            <aside className="rounded-[14px] border border-border bg-surface p-4 shadow-card lg:sticky lg:top-4 lg:p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[15px] font-semibold">Tinjau penilaian</h2>
                <Link href={listHref} className="text-sm font-medium text-primary">Tutup</Link>
              </div>
              <div className="mt-4">
                <ReviewForm mention={review} topics={props.workspace.topicLabels} />
              </div>
            </aside>
          ) : null}
        </div>
      )}
    </Frame>
  );
}

function pathFor(mode: "sebutan" | "perlu-perhatian" | "belum-yakin"): string {
  if (mode === "perlu-perhatian") return "/perlu-perhatian";
  if (mode === "belum-yakin") return "/belum-yakin";
  return "/sebutan";
}

function filterParams(
  props: { source: string; query: string },
  rangeKey: string,
  sentiment: string,
): Record<string, string | undefined> {
  return {
    rentang: rangeKey,
    sumber: props.source || undefined,
    sentimen: sentiment || undefined,
    q: props.query || undefined,
  };
}

function FilterBar(props: {
  mode: "sebutan" | "perlu-perhatian" | "belum-yakin";
  projectId: string | null;
  rangeKey: string;
  source: string;
  sentiment: string;
  query: string;
  filtersActive: boolean;
}) {
  const path = pathFor(props.mode);
  const href = (extra: Record<string, string | undefined>) =>
    projectHref(path, props.projectId, {
      rentang: props.rangeKey,
      sumber: props.source || undefined,
      sentimen: props.sentiment || undefined,
      q: props.query || undefined,
      ...extra,
    });
  return (
    <div className="flex flex-col gap-3">
      {props.mode === "sebutan" ? (
        <form className="flex min-w-0 flex-wrap gap-2" action={path}>
          {props.projectId ? <input type="hidden" name="proyek" value={props.projectId} /> : null}
          <input type="hidden" name="rentang" value={props.rangeKey} />
          {props.source ? <input type="hidden" name="sumber" value={props.source} /> : null}
          {props.sentiment ? <input type="hidden" name="sentimen" value={props.sentiment} /> : null}
          <input name="q" defaultValue={props.query} placeholder="Cari sebutan" aria-label="Cari sebutan" className="h-11 w-0 min-w-0 flex-1 basis-full rounded-lg border border-input-border bg-surface px-3 text-sm sm:basis-0" />
          <button type="submit" className="h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground">Cari</button>
        </form>
      ) : null}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Rentang tanggal">
        {(["7", "30", "90"] as const).map((key) => (
          <Link key={key} href={href({ rentang: key, halaman: undefined })} aria-current={props.rangeKey === key ? "true" : undefined} className={`inline-flex h-11 items-center rounded-lg px-3 text-sm ${props.rangeKey === key ? "bg-info-bg font-medium text-primary" : "text-muted-foreground"}`}>
            {key} hari
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sumber">
        <FilterChip href={href({ sumber: undefined, halaman: undefined })} current={!props.source} label="Semua sumber" />
        <FilterChip href={href({ sumber: "x", halaman: undefined })} current={props.source === "x"} label="X" />
        <FilterChip href={href({ sumber: "threads", halaman: undefined })} current={props.source === "threads"} label="Threads" />
        <FilterChip href={href({ sumber: "instagram", halaman: undefined })} current={props.source === "instagram"} label="Instagram" />
        <FilterChip href={href({ sumber: "tiktok", halaman: undefined })} current={props.source === "tiktok"} label="TikTok" />
      </div>
      {props.mode === "sebutan" ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sentimen">
          <FilterChip href={href({ sentimen: undefined, halaman: undefined })} current={!props.sentiment} label="Semua sentimen" />
          {(["positive", "neutral", "negative"] as const).map((value) => (
            <FilterChip key={value} href={href({ sentimen: value, halaman: undefined })} current={props.sentiment === value} label={SENTIMENT_LABEL[value]} />
          ))}
        </div>
      ) : null}
      {props.filtersActive ? (
        <Link href={projectHref(path, props.projectId)} className="inline-flex h-11 items-center text-sm font-medium text-primary">
          Hapus filter
        </Link>
      ) : null}
    </div>
  );
}

function FilterChip(props: { href: string; current: boolean; label: string }) {
  return (
    <Link href={props.href} aria-current={props.current ? "true" : undefined} className={`inline-flex h-11 items-center rounded-full border px-3 text-sm ${props.current ? "border-primary bg-info-bg font-medium text-primary" : "border-border bg-surface text-foreground"}`}>
      {props.label}
    </Link>
  );
}

function rowsFor(
  workspace: Workspace,
  mode: "sebutan" | "perlu-perhatian" | "belum-yakin",
  source: string,
  sentiment: Sentiment | "",
  start: Date,
  end: Date,
): PresentedMention[] {
  return workspace.mentions.filter((mention) => {
    if (!mentionInWindow(mention, start, end)) return false;
    if (source === "x" || source === "threads" || source === "instagram" || source === "tiktok") {
      if (mention.source !== source) return false;
    }
    if (sentiment && mention.sentiment !== sentiment) return false;
    if (mode === "perlu-perhatian") return mention.needsAttention;
    if (mode === "belum-yakin") return mention.bucket === "not_sure";
    return mention.bucket === "included" || mention.bucket === "pending" || mention.bucket === "failed" || mention.bucket === "policy_unapproved";
  });
}

function MentionLine(props: { mention: PresentedMention; now: string; href: string; mode: string }) {
  const mention = props.mention;
  return (
    <div className="flex gap-3">
      <span className="grid size-9 place-items-center rounded-full bg-surface-subtle text-xs font-semibold">{mention.initials}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px]">
          <SourceMark source={mention.source} /> <span className="font-medium">{mention.authorLabel}</span>{" "}
          <span className="text-muted-foreground">{mention.handle}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {mention.postedAt ? (
            <time dateTime={mention.postedAt}>
              {formatRelative(mention.postedAt, new Date(props.now))} · {formatWibClock(mention.postedAt)}
            </time>
          ) : (
            <span>Waktu postingan tidak tersedia · Dikumpulkan {formatWib(mention.collectedAt)}</span>
          )}
          {props.mode === "perlu-perhatian" ? <span> · {mention.attentionUnread ? "Baru" : "Sudah dilihat"}</span> : null}
          {mention.read ? <span> · Dibaca</span> : <span> · Belum dibaca</span>}
        </p>
        <p className="mt-1 line-clamp-2 text-sm leading-6">{mention.excerpt}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <SentimentTag sentiment={mention.sentiment} />
          <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-xs font-medium">
            {TEXT_MATCH_LABEL[mention.textMatch]}
          </span>
          {mention.needsAttention ? <span className="rounded-full bg-negatif-bg px-2 py-0.5 text-xs font-medium text-negatif">Sentimen negatif</span> : null}
          {mention.uncertainFields.map((field) => (
            <span key={field} className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning">
              {UNCERTAIN_LABEL[field]}
            </span>
          ))}
          {mention.bucket === "failed" ? <span className="text-xs text-danger">Penilaian gagal</span> : null}
          {mention.bucket === "pending" ? <span className="text-xs text-info">Menunggu penilaian</span> : null}
          {mention.bucket === "policy_unapproved" ? <span className="text-xs text-warning">Penilaian belum dipakai di ringkasan</span> : null}
          {mention.corrected ? <span className="text-xs text-info">Dikoreksi oleh Anda</span> : null}
        </div>
        <Link href={props.href} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-primary">
          Tinjau penilaian
        </Link>
      </div>
    </div>
  );
}
