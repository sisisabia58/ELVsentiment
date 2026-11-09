import { Suspense } from "react";
import Link from "next/link";
import { LogoutForm } from "@/components/logout-form";
import { EmptyState, PageHeader } from "@/components/monitor/bits";
import { SettingsForm } from "@/components/monitor/settings-form";
import { Frame } from "@/components/monitor/shell";
import { requireWorkspace } from "@/monitor/session-page";

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspace } = await requireWorkspace(id);
  const project = workspace.project?.id === id ? workspace.project : null;
  return (
    <Frame active="/proyek" workspace={workspace} logout={<LogoutForm />}>
      {!project ? (
        <>
          <PageHeader title="Pengaturan proyek" subtitle="Proyek tidak ditemukan." />
          <div className="mt-6">
            <EmptyState
              title="Proyek tidak ditemukan."
              body="Proyek yang Anda cari tidak ada atau sudah dihapus."
              action={
                <Link href="/proyek" className="text-sm font-medium text-primary">
                  Kembali ke Proyek
                </Link>
              }
            />
          </div>
        </>
      ) : (
        <>
          <PageHeader title="Pengaturan proyek" subtitle={`Kata kunci, sumber, dan jadwal untuk ${project.name}.`} />
          <SettingsForm
            projectId={project.id}
            brandName={project.name}
            keywords={workspace.keywords}
            keywordIntents={workspace.keywordIntents}
            sources={project.sources}
            schedule={project.schedule}
            credentials={workspace.credentials}
          />
        </>
      )}
    </Frame>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <Body params={params} />
    </Suspense>
  );
}
