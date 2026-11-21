import { Suspense } from "react";
import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { customerIdFromSessionToken } from "@/auth/session";
import { withSessionDeps } from "@/auth/request-session";
import { OnboardingWizard } from "@/components/monitor/onboarding-wizard";
import { runNowAction } from "@/app/dasbor/actions";
import { SOURCES_UNAVAILABLE_COPY } from "@/monitor/load";
import { ONBOARDING_DRAFT_COOKIE, onboardingLangkahRedirect, parseOnboardingDraft, resolveOnboardingState } from "@/monitor/onboarding-draft";
import { loadScheduledSourceAvailability } from "@/monitor/policy";
import { isUuid } from "@/monitor/search/load";
import { pantauFilterTriageEnabled } from "@/monitor/search/seed-project";
import { saveProjectConfiguration, type ProjectConfiguration } from "@/projects/handlers";
import { readLimits } from "@/projects/schedules";
import { requireWorkspace } from "@/monitor/session-page";

async function OnboardingGate({ fresh, langkah, draftRaw }: { fresh: boolean; langkah?: string; draftRaw?: string }) {
  const { customerId, workspace } = await requireWorkspace(undefined);
  const project = fresh ? null : workspace.project;
  const credentials = workspace.credentials;
  const existing = project
    ? {
        projectId: project.id,
        brandName: project.name,
        keywords: workspace.keywords,
        sources: project.sources,
        schedule: project.schedule,
      }
    : null;
  const initial = resolveOnboardingState({
    fresh,
    langkah,
    draft: parseOnboardingDraft(draftRaw),
    customerId,
    existing,
    credentials,
  });
  const cariAttemptId = initial.cariAttemptId;
  const redirectTo = onboardingLangkahRedirect({ langkah, fresh, resolvedStep: initial.step });
  if (redirectTo) redirect(redirectTo);
  async function runNow(projectId: string): Promise<{ ok: boolean; error?: string }> {
    "use server";
    const result = await withSessionDeps((deps) => runNowAction(projectId, deps));
    refresh();
    if (!result.ok && result.reason === "sources_unavailable") return { ok: false, error: SOURCES_UNAVAILABLE_COPY };
    return { ok: result.ok };
  }
  async function saveCari(input: Omit<ProjectConfiguration, "now"> & { importSearchPosts: boolean }) {
    "use server";
    return withSessionDeps(async (deps) => {
      const tenant = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
      if (!isUuid(cariAttemptId) || tenant !== customerId) {
        return { ok: false as const, error: "Halaman tidak ditemukan atau Anda tidak memiliki akses." };
      }
      const result = await saveProjectConfiguration(
        deps.db, tenant,
        { ...input, projectId: cariAttemptId, now: new Date() },
        readLimits(), await loadScheduledSourceAvailability(deps.db),
        { importSearchPosts: input.importSearchPosts === true },
      );
      return result.ok ? { ok: true as const, projectId: cariAttemptId } : result;
    });
  }
  return <OnboardingWizard credentials={credentials} existing={existing} initial={initial} onRun={runNow}
    saveCari={isUuid(cariAttemptId) ? saveCari : undefined} showCariImport={pantauFilterTriageEnabled()} />;
}

export default function OnboardingPage({ searchParams }: { searchParams: Promise<{ baru?: string; langkah?: string }> }) {
  return (
    <Suspense fallback={null}>
      <OnboardingBody searchParams={searchParams} />
    </Suspense>
  );
}

async function OnboardingBody({ searchParams }: { searchParams: Promise<{ baru?: string; langkah?: string }> }) {
  const filters = await searchParams;
  const jar = await cookies();
  return <OnboardingGate fresh={filters.baru === "1"} langkah={filters.langkah} draftRaw={jar.get(ONBOARDING_DRAFT_COOKIE)?.value} />;
}
