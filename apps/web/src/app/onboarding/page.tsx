import { Suspense } from "react";
import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { withSessionDeps } from "@/auth/request-session";
import { OnboardingWizard } from "@/components/monitor/onboarding-wizard";
import { runNowAction } from "@/app/dasbor/actions";
import { SOURCES_UNAVAILABLE_COPY } from "@/monitor/load";
import { ONBOARDING_DRAFT_COOKIE, onboardingLangkahRedirect, parseOnboardingDraft, resolveOnboardingState } from "@/monitor/onboarding-draft";
import { sourceCredentials } from "@/monitor/policy";
import { requireWorkspace } from "@/monitor/session-page";

async function OnboardingGate({ fresh, langkah, draftRaw }: { fresh: boolean; langkah?: string; draftRaw?: string }) {
  const { customerId, workspace } = await requireWorkspace(undefined);
  const project = fresh ? null : workspace.project;
  const credentials = sourceCredentials();
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
    draft: fresh ? null : parseOnboardingDraft(draftRaw),
    customerId,
    existing,
    credentials,
  });
  const redirectTo = onboardingLangkahRedirect({ langkah, fresh, resolvedStep: initial.step });
  if (redirectTo) redirect(redirectTo);
  async function runNow(projectId: string): Promise<{ ok: boolean; error?: string }> {
    "use server";
    const result = await withSessionDeps((deps) => runNowAction(projectId, deps));
    refresh();
    if (!result.ok && result.reason === "sources_unavailable") return { ok: false, error: SOURCES_UNAVAILABLE_COPY };
    return { ok: result.ok };
  }
  return <OnboardingWizard credentials={credentials} existing={existing} initial={initial} onRun={runNow} />;
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
