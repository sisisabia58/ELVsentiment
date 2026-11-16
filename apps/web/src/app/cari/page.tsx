import { Suspense } from "react";
import { notFound } from "next/navigation";
import { LogoutForm } from "@/components/logout-form";
import { PageHeader } from "@/components/monitor/bits";
import { SearchScreen } from "@/components/monitor/cari/search-screen";
import { Frame } from "@/components/monitor/shell";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { requireWorkspace } from "@/monitor/session-page";

export async function CariPageBody() {
  if (!cariSekarangEnabled()) notFound();
  const { workspace, now } = await requireWorkspace(undefined);
  return (
    <Frame active="/cari" workspace={workspace} logout={<LogoutForm />}>
      <PageHeader
        title="Cari sekarang"
        subtitle="Cari merek, produk, atau topik di media sosial dan web, lalu lihat hasilnya segera."
      />
      <SearchScreen history={[]} now={now.toISOString()} />
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
