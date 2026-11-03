import { Suspense } from "react";
import { MentionDetail } from "@/components/monitor/mention-detail";
import { requireWorkspace } from "@/monitor/session-page";

async function Body({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ proyek?: string }> }) {
  const [{ id }, filters] = await Promise.all([params, searchParams]);
  const { workspace } = await requireWorkspace(filters.proyek);
  return <MentionDetail workspace={workspace} mention={workspace.mentions.find((mention) => mention.id === id) ?? null} />;
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
