import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LogoutForm } from "@/components/logout-form";
import { CariNotFoundCard } from "@/components/monitor/cari/not-found-card";
import { Frame } from "@/components/monitor/shell";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { requireWorkspace } from "@/monitor/session-page";

export async function CariNotFoundPageBody() {
  await connection();
  if (!cariSekarangEnabled()) notFound();
  const { workspace } = await requireWorkspace(undefined);
  return (
    <Frame active="/cari" workspace={workspace} logout={<LogoutForm />}>
      <CariNotFoundCard />
    </Frame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CariNotFoundPageBody />
    </Suspense>
  );
}
