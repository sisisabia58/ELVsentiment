import { Suspense } from "react";
import { MentionsScreen } from "@/components/monitor/mentions-view";
import { requireWorkspace } from "@/monitor/session-page";

type Filters = { proyek?: string; rentang?: string; sumber?: string; halaman?: string; tinjau?: string };

async function Body({ searchParams }: { searchParams: Promise<Filters> }) {
  const filters = await searchParams;
  const { now, workspace } = await requireWorkspace(filters.proyek);
  return (
    <MentionsScreen
      workspace={workspace}
      now={now.toISOString()}
      mode="belum-yakin"
      page={Math.max(1, Math.floor(Number(filters.halaman ?? "1")) || 1)}
      range={filters.rentang ?? "7"}
      source={filters.sumber ?? ""}
      query=""
      reviewId={filters.tinjau}
    />
  );
}

export default function Page({ searchParams }: { searchParams: Promise<Filters> }) {
  return (
    <Suspense fallback={null}>
      <Body searchParams={searchParams} />
    </Suspense>
  );
}
