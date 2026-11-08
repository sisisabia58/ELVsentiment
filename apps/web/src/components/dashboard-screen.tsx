import type { ReactNode } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { emptyCollectionBody, SCORE_FORMULA_LABEL, scoringFailureCopy } from "@/monitor/copy";
import { collectionSentence, type CollectionOutcome } from "@/projects/dashboard-status";
import type { DashboardModel } from "@/monitor/dashboard";
import { formatNumber, formatWib } from "@/monitor/format";
import { projectHref } from "@/monitor/links";
import type { PresentedMention } from "@/monitor/present";
import { SENTIMENT_LABEL } from "@/monitor/present";
import { ChangeLine, EmptyState, PageHeader, Panel, ScoreValue, SentimentTag, SourceMark, Sparkline } from "./monitor/bits";
import { CompositionChart, TrendChart, VolumeChart } from "./monitor/charts";
import { RunButton } from "./monitor/run-button";
import { WorkspaceShell } from "./monitor/shell";
import { TextMatchSummary } from "./monitor/text-match-summary";

function sourceStateText(state: string): string {
  return state.trim() === "Tidak tersedia" ? "Status sumber: Tidak tersedia" : state;
}

export function DashboardScreen(props: {
  brandName: string | null;
  projectId?: string | null;
  from: string;
  to: string;
  source: string;
  outcome: CollectionOutcome;
  lastSuccess?: string;
  pending?: number;
  failed?: number;
  sourceState?: string;
  onRunNow: () => void | Promise<{ ok: boolean } | void>;
  logout?: ReactNode;
  collection: {
    lastSeenAt: string | null;
    now: string;
    staleSeconds: number;
    manualBlocked: boolean;
    retryAt?: string | null;
    inProgress?: boolean;
  } | null;
  accountName?: string;
  accountEmail?: string;
  initials?: string;
  projects?: { id: string; name: string; initials: string }[];
  attention?: number;
  uncertain?: number;
  model?: DashboardModel | null;
  updatedAt?: string | null;
  denied?: boolean;
  runNote?: string | null;
  sourceLines?: string[];
}) {
  const stale =
    props.collection !== null &&
    (props.collection.lastSeenAt === null ||
      new Date(props.collection.now).getTime() - new Date(props.collection.lastSeenAt).getTime() >
        props.collection.staleSeconds * 1000);
  const projectId = props.projectId ?? null;
  const range = props.model?.range ?? "7";
  const scoreValue = props.model?.score.kind === "score" ? props.model.score.value : null;
  const included = props.model?.score.kind === "score" ? props.model.score.included : null;
  const failureCopy = scoringFailureCopy(props.failed ?? 0);
  const runAvailable = !props.runNote;

  return (
    <WorkspaceShell
      active="/dasbor"
      projectId={projectId}
      projectName={props.brandName}
      projects={props.projects ?? (props.brandName && projectId ? [{ id: projectId, name: props.brandName, initials: props.initials ?? "?" }] : [])}
      accountName={props.accountName ?? "Pemilik"}
      accountEmail={props.accountEmail ?? ""}
      initials={props.initials ?? "P"}
      attention={props.attention ?? 0}
      uncertain={props.uncertain ?? 0}
      logout={props.logout}
    >
      <div className="mx-auto w-full max-w-[1320px] px-4 pb-28 pt-5 lg:px-8 lg:pt-8">
        <PageHeader
          title={props.brandName ? "Ringkasan" : "Dasbor"}
          subtitle={
            props.brandName
              ? `Gambaran sentimen percakapan tentang ${props.brandName}.`
              : "Belum ada proyek. Tambahkan merek untuk mulai memantau."
          }
          meta={props.updatedAt ? `Terakhir diperbarui ${formatWib(props.updatedAt)}` : undefined}
          actions={
            props.collection ? (
              <RunButton
                stale={stale}
                disabled={props.collection.manualBlocked || Boolean(props.runNote)}
                inProgress={props.collection.inProgress}
                retryAt={props.collection.retryAt}
                note={props.runNote}
                onRun={props.onRunNow}
              />
            ) : (
              <Link href="/onboarding" className={buttonVariants()}>
                Buat proyek
              </Link>
            )
          }
        />
        {props.denied ? (
          <div className="mt-5">
            <EmptyState
              title="Halaman tidak ditemukan atau Anda tidak memiliki akses."
              body="Kembali ke dasbor untuk membuka proyek Anda."
              action={
                <Link href="/dasbor" className={buttonVariants()}>
                  Kembali ke dasbor
                </Link>
              }
            />
          </div>
        ) : !props.brandName ? (
          <div className="mt-5">
            <EmptyState
              title="Belum ada proyek."
              body="Tambahkan merek untuk mulai memantau."
              action={
                <Link href="/onboarding" className={buttonVariants()}>
                  Siapkan pemantauan
                </Link>
              }
            />
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-4 lg:gap-5">
            <div className="flex flex-wrap items-center gap-2">
              {(["7", "30", "90"] as const).map((item) => (
                <Link
                  key={item}
                  href={projectHref("/dasbor", projectId, { rentang: item, sumber: props.source || undefined })}
                  className={
                    range === item
                      ? "inline-flex min-h-[44px] min-w-[44px] max-w-full items-center rounded-lg bg-info-bg px-3 text-sm font-medium text-primary"
                      : "inline-flex min-h-[44px] min-w-[44px] max-w-full items-center rounded-lg px-3 text-sm text-muted-foreground"
                  }
                  aria-current={range === item ? "page" : undefined}
                >
                  {item} hari
                </Link>
              ))}
              <span className="inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm text-muted-foreground">Sumber</span>
              <Link href={projectHref("/dasbor", projectId, { rentang: range })} className="inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary">
                Semua sumber
              </Link>
            </div>
            {props.outcome === "none" ? (
              <EmptyState
                title="Belum ada data."
                body={emptyCollectionBody(runAvailable)}
                note="Akses sumber dikelola oleh kami. Anda tidak perlu menghubungkan akun."
              />
            ) : null}
            <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4 lg:gap-5">
              <Panel>
                <p className="text-[13px] font-medium text-muted-foreground">Skor sentimen</p>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <ScoreValue value={scoreValue} />
                  <Sparkline values={props.model?.points.map((point) => point.score) ?? []} className="h-9 w-24 text-primary" />
                </div>
                <details className="mt-2">
                  <summary className="inline-flex min-h-[44px] min-w-[44px] max-w-full cursor-pointer items-center text-xs text-muted-foreground">{SCORE_FORMULA_LABEL}</summary>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Dihitung dari 100 × (positif − negatif) ÷ seluruh sebutan yang dinilai. Rentang −100 sampai +100. Ini bukan tingkat keyakinan penilaian otomatis.
                  </p>
                </details>
                {included === null ? (
                  <p className="mt-1 text-sm">Belum ada sebutan yang dinilai</p>
                ) : (
                  <p className="mt-1 text-sm tabular-nums">{formatNumber(included)} sebutan dinilai</p>
                )}
                <ChangeLine change={props.model?.comparison.score ?? null} higherIsBetter periodLabel={`${range} hari sebelumnya`} unit="poin" />
              </Panel>
              <Panel>
                <p className="text-[13px] font-medium text-muted-foreground">Sebutan dinilai</p>
                <p className="mt-2 text-[32px] font-semibold leading-none tabular-nums">{included === null ? "—" : formatNumber(included)}</p>
                <ChangeLine change={props.model?.comparison.mentions ?? null} higherIsBetter periodLabel={`${range} hari sebelumnya`} />
              </Panel>
              <Panel>
                <p className="text-[13px] font-medium text-muted-foreground">Perlu perhatian</p>
                <p className="mt-2 text-[32px] font-semibold leading-none tabular-nums">
                  {formatNumber(props.model?.attentionInRange ?? props.attention ?? 0)}
                </p>
                <ChangeLine change={props.model?.comparison.attention ?? null} higherIsBetter={false} periodLabel={`${range} hari sebelumnya`} />
                <Link className="mt-3 inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" href={projectHref("/perlu-perhatian", projectId, { rentang: range })}>
                  Dalam filter ini
                </Link>
              </Panel>
              <Panel>
                <p className="text-[13px] font-medium text-muted-foreground">Belum yakin</p>
                <p className="mt-2 text-[32px] font-semibold leading-none tabular-nums">
                  {formatNumber(props.model?.uncertainInRange ?? props.uncertain ?? 0)}
                </p>
                <ChangeLine change={props.model?.comparison.uncertain ?? null} higherIsBetter={false} periodLabel={`${range} hari sebelumnya`} />
                <Link className="mt-3 inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" href={projectHref("/belum-yakin", projectId, { rentang: range })}>
                  Tinjau
                </Link>
              </Panel>
            </div>
            <Panel title="Relevansi teks">
              <TextMatchSummary
                counts={props.model?.textMatch ?? { candidates: 0, literal: 0, unknown: 0 }}
              />
            </Panel>
            {props.model ? (
              <div className="grid min-w-0 gap-4 xl:grid-cols-3 lg:gap-5">
                <Panel title="Tren sentimen" subtitle={props.model.periodLabel} className="xl:col-span-2">
                  <TrendChart points={props.model.points} periodLabel={props.model.periodLabel} />
                </Panel>
                <Panel title="Komposisi sentimen" subtitle="Hanya sebutan yang sudah dinilai.">
                  <CompositionChart positif={props.model.totals.positif} netral={props.model.totals.netral} negatif={props.model.totals.negatif} />
                </Panel>
              </div>
            ) : null}
            {props.model ? (
              <div className="grid min-w-0 gap-4 lg:grid-cols-2 xl:grid-cols-3 lg:gap-5">
                <Panel title="Jumlah sebutan dinilai">
                  <VolumeChart points={props.model.points} />
                </Panel>
                <Panel title="Topik teratas" subtitle="Satu sebutan dapat memiliki lebih dari satu topik; jumlah topik dapat melebihi jumlah sebutan.">
                  {props.model.topics.length === 0 ? (
                    <p>Belum ada topik yang dapat ditampilkan.</p>
                  ) : (
                    <ul className="space-y-2">
                      {props.model.topics.map((topic) => (
                        <li key={topic.label}>
                          <Link className="flex min-h-[44px] w-full min-w-0 max-w-full items-center justify-between gap-3 text-sm" href={projectHref("/sebutan", projectId, { topik: topic.label, rentang: range })}>
                            <span className="min-w-0 break-words">{topic.label}</span>
                            <span className="tabular-nums">{formatNumber(topic.count)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
                <AttentionPreview items={props.model.attentionItems} projectId={projectId} range={range} />
              </div>
            ) : (
              <Panel title="Topik teratas">
                <p>Belum ada topik yang dapat ditampilkan.</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Satu sebutan dapat memiliki lebih dari satu topik; jumlah topik dapat melebihi jumlah sebutan.
                </p>
              </Panel>
            )}
            <Panel title="Status data">
              <p>{collectionSentence(props.outcome, props.lastSuccess ?? "")}</p>
              <p className="mt-2">Menunggu penilaian {formatNumber(props.pending ?? 0)}</p>
              {failureCopy ? <p>{failureCopy}</p> : null}
              {props.sourceLines && props.sourceLines.length > 0 ? (
                props.sourceLines.map((line) => <p key={line}>{line}</p>)
              ) : (
                <p>{sourceStateText(props.sourceState ?? "")}</p>
              )}
              <Link className="mt-3 inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" href={projectHref("/pengumpulan", projectId)}>
                Lihat pengumpulan
              </Link>
            </Panel>
            <Link href={projectId ? projectHref(`/proyek/${projectId}/pengaturan`, null) : "/onboarding"} className="inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary">
              Ubah kata kunci merek
            </Link>
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}

function AttentionPreview(props: { items: PresentedMention[]; projectId: string | null; range: string }) {
  return (
    <Panel title="Perlu perhatian" subtitle="Dalam filter ini">
      {props.items.length === 0 ? (
        <p>Tidak ada sebutan yang perlu perhatian dalam filter ini.</p>
      ) : (
        <ul className="space-y-3">
          {props.items.map((item) => (
            <li key={item.id} className="border-b border-border pb-3 last:border-0">
              <p className="text-[13px] font-medium">
                <SourceMark source={item.source} /> {item.authorLabel}
              </p>
              <p className="mt-1 line-clamp-2 text-sm">{item.excerpt}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <SentimentTag sentiment={item.sentiment} />
                {item.attentionUnread ? <span className="text-xs">Baru</span> : <span className="text-xs">Sudah dilihat</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link className="mt-3 inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" href={projectHref("/perlu-perhatian", props.projectId, { rentang: props.range })}>
        Lihat semua
      </Link>
      <p className="sr-only">{SENTIMENT_LABEL.negative}</p>
    </Panel>
  );
}
