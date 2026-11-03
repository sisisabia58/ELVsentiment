import { Suspense } from "react";
import { MentionsScreen } from "@/components/monitor/mentions-view";
import { requireWorkspace } from "@/monitor/session-page";

type Filters = {
  proyek?: string;
  rentang?: string;
  sumber?: string;
  sentimen?: string;
  q?: string;
  halaman?: string;
  tinjau?: string;
};

async function Body({ searchParams }: { searchParams: Promise<Filters> }) {
  const filters = await searchParams;
  const { now, workspace } = await requireWorkspace(filters.proyek);
  return (
    <MentionsScreen
      workspace={workspace}
      now={now.toISOString()}
      mode="sebutan"
      page={positive(filters.halaman)}
      range={filters.rentang ?? "7"}
      source={filters.sumber ?? ""}
      sentiment={filters.sentimen}
      query={filters.q ?? ""}
      reviewId={filters.tinjau}
    />
  );
}

function positive(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

export default function Page({ searchParams }: { searchParams: Promise<Filters> }) {
  return (
    <Suspense fallback={null}>
      <Body searchParams={searchParams} />
    </Suspense>
  );
}
