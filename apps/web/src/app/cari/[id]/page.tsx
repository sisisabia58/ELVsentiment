import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LogoutForm } from "@/components/logout-form";
import { EmptyState } from "@/components/monitor/bits";
import { SearchDetail } from "@/components/monitor/cari/search-screen";
import { Frame } from "@/components/monitor/shell";
import { withClient } from "@/db/pg";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { loadSearchSnapshot } from "@/monitor/search/load";
import { requireWorkspace } from "@/monitor/session-page";

export async function CariDetailPageBody({ id }: { id: string }) {
  await connection();
  if (!cariSekarangEnabled()) notFound();
  const { customerId, workspace } = await requireWorkspace(undefined);
  const snapshot = await withClient((db) => loadSearchSnapshot(db, customerId, id));
  if (!snapshot) {
    return (
      <Frame active="/cari" workspace={workspace} logout={<LogoutForm />}>
        <EmptyState
          title="Pencarian tidak ditemukan."
          body="Pencarian ini tidak ada atau bukan milik akun Anda. Coba cari lagi dari halaman Cari sekarang."
          action={
            <Link href="/cari" className="text-sm font-medium text-primary">
              Kembali ke Cari sekarang
            </Link>
          }
        />
      </Frame>
    );
  }
  return (
    <Frame active="/cari" workspace={workspace} logout={<LogoutForm />}>
      <SearchDetail initialSnapshot={snapshot} />
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
