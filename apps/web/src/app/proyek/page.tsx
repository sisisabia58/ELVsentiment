import { Suspense } from "react";
import { ProjectsView } from "@/components/monitor/projects-view";
import { requireWorkspace } from "@/monitor/session-page";

async function Body({ searchParams }: { searchParams: Promise<{ proyek?: string }> }) {
  const filters = await searchParams;
  const { workspace } = await requireWorkspace(filters.proyek);
  return <ProjectsView workspace={workspace} />;
}

export default function Page({ searchParams }: { searchParams: Promise<{ proyek?: string }> }) {
  return (
    <Suspense fallback={null}>
      <Body searchParams={searchParams} />
    </Suspense>
  );
}
