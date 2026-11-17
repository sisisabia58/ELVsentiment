import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LogoutForm } from "@/components/logout-form";
import { HistoryList } from "@/components/monitor/cari/history-list";
import { PageHeader } from "@/components/monitor/bits";
import { Frame } from "@/components/monitor/shell";
import { withClient } from "@/db/pg";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { loadHistory } from "@/monitor/search/load";
import { requireWorkspace } from "@/monitor/session-page";

export async function RiwayatPageBody() {
  await connection();
  if (!cariSekarangEnabled()) notFound();
  const { customerId, workspace, now } = await requireWorkspace(undefined);
  const rows = await withClient((db) => loadHistory(db, customerId));
  return (
    <Frame active="/cari/riwayat" workspace={workspace} logout={<LogoutForm />}>
      <PageHeader
        title="Riwayat pencarian"
        subtitle="Semua pencarian cepat Anda dalam 30 hari terakhir. Buka lagi untuk melihat hasilnya."
      />
      <div className="mt-5">
        <HistoryList rows={rows} now={now} aiEnabled={workspace.cariAiEnabled} />
      </div>
    </Frame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <RiwayatPageBody />
    </Suspense>
  );
}
