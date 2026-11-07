import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { LogoutForm } from "@/components/logout-form";
import { formatWib } from "@/monitor/format";
import { projectHref } from "@/monitor/links";
import type { Workspace } from "@/monitor/load";
import { sourceHealthCopy } from "@/monitor/load";
import { SOURCE_NAME } from "@/monitor/policy";
import { choiceLabel } from "@/monitor/schedule-choice";
import { EmptyState, PageHeader, Panel } from "./bits";
import { Frame } from "./shell";
import { RunButton } from "./run-button";
import { CollectionSchedule } from "./collection-schedule";

export function CollectionView(props: {
  workspace: Workspace;
  now: string;
  staleSeconds: number;
  onRun: () => Promise<{ ok: boolean; error?: string }>;
  runNote?: string | null;
}) {
  const project = props.workspace.project;
  const stale =
    props.workspace.control.lastSeenAt === null ||
    new Date(props.now).getTime() - new Date(props.workspace.control.lastSeenAt).getTime() > props.staleSeconds * 1000;
  return (
    <Frame active="/pengumpulan" workspace={props.workspace} logout={<LogoutForm />}>
      <PageHeader
        title="Pengumpulan"
        subtitle={project ? "Status sumber data dan riwayat proses pengumpulan sebutan." : "Belum ada proyek. Tambahkan merek untuk mulai memantau."}
      />
      {props.workspace.projectMissing ? (
        <div className="mt-5">
          <EmptyState
            title="Halaman tidak ditemukan atau Anda tidak memiliki akses."
            body="Kembali ke dasbor untuk membuka proyek Anda."
            action={<Link href="/dasbor" className="text-sm font-medium text-primary">Kembali ke dasbor</Link>}
          />
        </div>
      ) : !project ? (
        <div className="mt-5">
          <EmptyState title="Belum ada proyek." body="Tambahkan merek untuk mulai memantau." action={<Link href="/onboarding" className="text-sm font-medium text-primary">Buat proyek</Link>} />
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-4 lg:gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {props.workspace.sources.map((health) => (
              <Panel key={health.source} title={SOURCE_NAME[health.source]}>
                <p className="text-sm leading-6">{sourceHealthCopy(health)}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {health.lastSuccessAt ? `Berhasil terakhir ${formatWib(health.lastSuccessAt)}` : "Belum ada pengumpulan yang berhasil dari sumber ini."}
                </p>
              </Panel>
            ))}
          </div>
          <p className="flex items-start gap-1.5 text-[13px] leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Akses sumber dikelola oleh kami. Anda tidak perlu menghubungkan akun.
          </p>
          <div className="grid items-start gap-4 lg:grid-cols-2 lg:gap-5">
            <Panel title="Jalankan sekarang" subtitle="Jeda minimal antar-pengumpulan: 15 menit.">
              <RunButton
                stale={stale}
                disabled={props.workspace.control.manualBlocked || Boolean(props.runNote)}
                inProgress={props.workspace.control.inProgress}
                retryAt={props.workspace.control.retryAt}
                note={props.runNote}
                onRun={props.onRun}
              />
            </Panel>
            <Panel title="Jadwal pengumpulan" subtitle={choiceLabel(project.schedule)}>
              <CollectionSchedule projectId={project.id} value={project.schedule} />
              {project.nextRunAt ? <p className="mt-3 text-xs text-muted-foreground">Berikutnya {formatWib(project.nextRunAt)}</p> : null}
            </Panel>
          </div>
          <Panel title="Riwayat">
            {props.workspace.jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada riwayat pengumpulan.</p>
            ) : (
              <ul className="divide-y divide-border">
                {props.workspace.jobs.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-medium">
                        {job.label} · {job.kind === "manual" ? "Manual" : "Terjadwal"}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatWib(job.createdAt)}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{job.explanation}</p>
                    </div>
                    <Link href={projectHref(`/pengumpulan/${job.id}`, project.id)} className="inline-flex h-11 items-center text-sm font-medium text-primary">
                      Detail
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </Frame>
  );
}
