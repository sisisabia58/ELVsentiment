import { Suspense } from "react";
import { io, refresh } from "next/cache";
import { sessionCustomerId, withSessionDeps } from "@/auth/request-session";
import { DashboardScreen } from "@/components/dashboard-screen";
import { LogoutForm } from "@/components/logout-form";
import { withCustomer } from "@/db/migrate";
import { withClient } from "@/db/pg";
import { dashboardFor, loadWorkspace, selectedSourcesReady, SOURCES_UNAVAILABLE_COPY } from "@/monitor/load";
import { sourceStatusLines } from "@/monitor/source-status";
import { collectionOutcome, readProjectCollection } from "@/projects/dashboard-status";
import { readLimits } from "@/projects/schedules";
import { redirect } from "next/navigation";
import { runNowAction } from "./actions";

async function DashboardBody({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; source?: string; rentang?: string; sumber?: string; proyek?: string }>;
}) {
  await io();
  const customerId = await sessionCustomerId();
  if (!customerId) redirect("/masuk");
  const filters = await searchParams;
  const from = filters.from ?? "";
  const to = filters.to ?? "";
  const source = filters.sumber ?? filters.source ?? "";
  const limits = readLimits();
  const now = new Date();
  const workspace = await withClient((db) => loadWorkspace(db, customerId, filters.proyek, now, limits));
  if (workspace.projectMissing) {
    return (
      <DashboardScreen
        denied
        brandName={null}
        projectId={null}
        from=""
        to=""
        source=""
        outcome="none"
        onRunNow={() => undefined}
        logout={<LogoutForm />}
        collection={null}
        accountName={workspace.displayName}
        accountEmail={workspace.email}
        initials={workspace.initials}
        projects={workspace.projects.map((project) => ({ id: project.id, name: project.name, initials: project.initials }))}
        model={null}
      />
    );
  }
  if (!workspace.project) redirect("/onboarding");
  const projectId = workspace.project.id;
  const collection = await withClient((db) =>
    withCustomer(db, customerId, () => readProjectCollection(db, projectId)),
  );
  const outcome = collectionOutcome({ hasProject: true, latestStatus: collection.latestStatus });
  const model = dashboardFor(workspace, filters.rentang, source || undefined, now);
  const sourceState = collection.sourceState;

  async function runNow(): Promise<{ ok: boolean; error?: string }> {
    "use server";
    const result = await withSessionDeps((deps) => runNowAction(projectId, deps));
    refresh();
    if (!result.ok && result.reason === "sources_unavailable") return { ok: false, error: SOURCES_UNAVAILABLE_COPY };
    return { ok: result.ok };
  }

  return (
    <DashboardScreen
      brandName={workspace.project.name}
      projectId={projectId}
      from={from}
      to={to}
      source={source}
      outcome={outcome}
      lastSuccess={collection.lastCollectedAt}
      pending={collection.pending}
      failed={collection.failed}
      sourceState={sourceState}
      onRunNow={runNow}
      logout={<LogoutForm />}
      collection={{
        lastSeenAt: workspace.control.lastSeenAt,
        now: now.toISOString(),
        staleSeconds: limits.workerHeartbeatStaleSeconds,
        manualBlocked: workspace.control.manualBlocked || workspace.control.inProgress,
        retryAt: workspace.control.retryAt,
        inProgress: workspace.control.inProgress,
      }}
      accountName={workspace.displayName}
      accountEmail={workspace.email}
      initials={workspace.initials}
      projects={workspace.projects.map((project) => ({ id: project.id, name: project.name, initials: project.initials }))}
      attention={model.attentionUnread}
      uncertain={model.uncertainOpen}
      model={workspace.mentions.length > 0 || outcome !== "none" ? model : null}
      updatedAt={collection.lastCollectedAt || null}
      runNote={selectedSourcesReady(workspace.project.sources, workspace.sources) ? null : SOURCES_UNAVAILABLE_COPY}
      sourceLines={sourceStatusLines(workspace.sources)}
    />
  );
}

export default function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; source?: string; rentang?: string; sumber?: string; proyek?: string }>;
}) {
  return (
    <Suspense fallback={null}>
      <DashboardBody searchParams={searchParams} />
    </Suspense>
  );
}
