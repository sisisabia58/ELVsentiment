import { Suspense } from "react";
import { notFound } from "next/navigation";
import { adminEmailForCustomer, isAdminEmail } from "@/auth/admin";
import { withSessionDeps } from "@/auth/request-session";
import { LogoutForm } from "@/components/logout-form";
import { PageHeader } from "@/components/monitor/bits";
import { ProviderSettingsForm } from "@/components/monitor/cari/provider-settings-form";
import { Frame } from "@/components/monitor/shell";
import { withCustomer } from "@/db/migrate";
import { withClient } from "@/db/pg";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { loadProviderSettingRows } from "@/monitor/search/provider-settings";
import { requireWorkspace } from "@/monitor/session-page";
import {
  saveProviderSettingAction,
  type ProviderSettingActionInput,
} from "./actions";

export async function ProviderPageBody() {
  if (!cariSekarangEnabled()) notFound();
  const { customerId, workspace } = await requireWorkspace(undefined);

  const data = await withClient(async (db) => {
    const email = await withCustomer(db, customerId, () =>
      adminEmailForCustomer(db, customerId),
    );
    if (!isAdminEmail(email)) return { authorized: false as const };
    return { authorized: true as const, rows: await loadProviderSettingRows(db) };
  });

  async function save(input: ProviderSettingActionInput) {
    "use server";
    return withSessionDeps((deps) => saveProviderSettingAction(input, deps));
  }

  return (
    <Frame active="/pengaturan/provider" workspace={workspace} logout={<LogoutForm />}>
      <PageHeader
        title="Pengaturan penyedia"
        subtitle="Mengatur penyedia untuk pencarian langsung dan komentar. Perubahan langsung berlaku."
      />
      <div className="mt-6 max-w-3xl">
        {data.authorized ? (
          <ProviderSettingsForm rows={data.rows} onSave={save} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Anda tidak berwenang mengubah penyedia pencarian.
          </p>
        )}
      </div>
    </Frame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ProviderPageBody />
    </Suspense>
  );
}
