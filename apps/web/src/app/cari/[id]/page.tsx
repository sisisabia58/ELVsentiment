import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LogoutForm } from "@/components/logout-form";
import { SearchDetail } from "@/components/monitor/cari/search-screen";
import { Frame } from "@/components/monitor/shell";
import { withClient } from "@/db/pg";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { isUuid, loadSearchSnapshot } from "@/monitor/search/load";
import { requireWorkspace } from "@/monitor/session-page";

export async function CariDetailPageBody({ id }: { id: string }) {
  await connection();
  if (!cariSekarangEnabled()) notFound();
  if (!isUuid(id)) notFound();
  const { customerId, now, workspace } = await requireWorkspace(undefined);
  const snapshot = await withClient((db) => loadSearchSnapshot(db, customerId, id));
  // The proxy already returns a real 404; this is the in-page fallback.
  if (!snapshot) notFound();
  return (
    <Frame active="/cari" workspace={workspace} logout={<LogoutForm />}>
      <SearchDetail initialSnapshot={snapshot} now={now.toISOString()} aiEnabled={workspace.cariAiEnabled === true} />
    </Frame>
  );
}

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CariDetailPageBody id={id} />;
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <Body params={params} />
    </Suspense>
  );
}
