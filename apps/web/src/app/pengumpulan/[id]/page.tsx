import { Suspense } from "react";
import Link from "next/link";
import { LogoutForm } from "@/components/logout-form";
import { EmptyState, PageHeader } from "@/components/monitor/bits";
import { Frame } from "@/components/monitor/shell";
import { formatWib } from "@/monitor/format";
import { projectHref } from "@/monitor/links";
import { requireWorkspace } from "@/monitor/session-page";

async function Body({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ proyek?: string }> }) {
  const [{ id }, filters] = await Promise.all([params, searchParams]);
  const { workspace } = await requireWorkspace(filters.proyek);
  const job = workspace.jobs.find((item) => item.id === id) ?? null;
  return (
    <Frame active="/pengumpulan" workspace={workspace} logout={<LogoutForm />}>
      <Link href={projectHref("/pengumpulan", workspace.project?.id)} className="text-sm font-medium text-primary">
        Kembali ke Pengumpulan
      </Link>
      {!job ? (
        <div className="mt-5">
          <EmptyState title="Riwayat tidak ditemukan." body="Pengumpulan ini tidak ada pada proyek yang sedang dibuka." />
        </div>
      ) : (
        <div className="mt-4">
          <PageHeader title={job.label} subtitle={job.explanation} meta={formatWib(job.createdAt)} />
          <p className="mt-4 text-sm text-muted-foreground">{job.kind === "manual" ? "Manual" : "Terjadwal"}</p>
        </div>
      )}
    </Frame>
  );
}

export default function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ proyek?: string }>;
}) {
  return (
    <Suspense fallback={null}>
      <Body params={params} searchParams={searchParams} />
    </Suspense>
  );
}
