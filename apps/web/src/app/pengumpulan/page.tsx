import { Suspense } from "react";
import { refresh } from "next/cache";
import { withSessionDeps } from "@/auth/request-session";
import { CollectionView } from "@/components/monitor/collection-view";
import { runNowAction } from "@/app/dasbor/actions";
import { readLimits } from "@/projects/schedules";
import { SOURCES_UNAVAILABLE_COPY, selectedSourcesReady } from "@/monitor/load";
import { requireWorkspace } from "@/monitor/session-page";

async function Body({ searchParams }: { searchParams: Promise<{ proyek?: string }> }) {
  const filters = await searchParams;
  const { now, workspace } = await requireWorkspace(filters.proyek);
  const projectId = workspace.project?.id ?? "";
  async function runNow(): Promise<{ ok: boolean; error?: string }> {
    "use server";
    if (!projectId) return { ok: false };
    const result = await withSessionDeps((deps) => runNowAction(projectId, deps));
    refresh();
    if (!result.ok && result.reason === "sources_unavailable") return { ok: false, error: SOURCES_UNAVAILABLE_COPY };
    return { ok: result.ok };
  }
  const sourcesReady = workspace.project ? selectedSourcesReady(workspace.project.sources, workspace.sources) : false;
  return (
    <CollectionView
      workspace={workspace}
      now={now.toISOString()}
      staleSeconds={readLimits().workerHeartbeatStaleSeconds}
      onRun={runNow}
      runNote={workspace.project && !sourcesReady ? SOURCES_UNAVAILABLE_COPY : null}
    />
  );
}

export default function Page({ searchParams }: { searchParams: Promise<{ proyek?: string }> }) {
  return (
    <Suspense fallback={null}>
      <Body searchParams={searchParams} />
    </Suspense>
  );
}
