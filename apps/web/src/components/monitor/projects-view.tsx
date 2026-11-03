import Link from "next/link";
import { Plus } from "lucide-react";
import { LogoutForm } from "@/components/logout-form";
import { formatWib } from "@/monitor/format";
import type { Workspace } from "@/monitor/load";
import { choiceLabel } from "@/monitor/schedule-choice";
import { EmptyState, PageHeader, Panel } from "./bits";
import { Frame } from "./shell";

export function ProjectsView(props: { workspace: Workspace }) {
  return (
    <Frame active="/proyek" workspace={props.workspace} logout={<LogoutForm />}>
      <PageHeader
        title="Proyek"
        subtitle="Merek yang Anda pantau."
        actions={
          <Link href="/onboarding?baru=1" className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground">
            <Plus className="size-4" aria-hidden="true" />
            Buat proyek
          </Link>
        }
      />
      <div className="mt-6">
        {props.workspace.projects.length === 0 ? (
          <EmptyState title="Belum ada proyek." body="Tambahkan merek untuk mulai memantau." action={<Link href="/onboarding" className="text-sm font-medium text-primary">Buat proyek</Link>} />
        ) : (
          <Panel>
            <ul className="divide-y divide-border">
              {props.workspace.projects.map((project) => (
                <li key={project.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{project.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {project.keywordCount} variasi · {project.sources.map((source) => (source === "x" ? "X" : "Threads")).join(", ")} · {choiceLabel(project.schedule)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {project.lastCollectedAt ? `Pengumpulan terakhir ${formatWib(project.lastCollectedAt)}` : "Belum ada pengumpulan data"}
                    </p>
                  </div>
                  <Link href={`/proyek/${project.id}/pengaturan`} className="inline-flex h-11 items-center text-sm font-medium text-primary">
                    Pengaturan
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </Frame>
  );
}
