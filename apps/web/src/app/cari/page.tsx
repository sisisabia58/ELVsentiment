import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LogoutForm } from "@/components/logout-form";
import { PageHeader } from "@/components/monitor/bits";
import { SearchScreen } from "@/components/monitor/cari/search-screen";
import { Frame } from "@/components/monitor/shell";
import { withClient } from "@/db/pg";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { loadHistory } from "@/monitor/search/load";
import { requireWorkspace } from "@/monitor/session-page";

export async function CariPageBody() {
  await connection();
  if (!cariSekarangEnabled()) notFound();
  const { customerId, workspace, now } = await requireWorkspace(undefined);
  const history = await withClient((db) => loadHistory(db, customerId, 6));
  return (
    <Frame active="/cari" workspace={workspace} logout={<LogoutForm />}>
      <PageHeader
        title="Cari sekarang"
        subtitle="Cari merek, produk, atau topik di media sosial dan web, lalu lihat hasilnya segera."
      />
      <SearchScreen history={history} now={now.toISOString()} />
    </Frame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CariPageBody />
    </Suspense>
  );
}
