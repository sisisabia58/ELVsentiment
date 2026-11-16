import { Suspense } from "react";
import { redirect } from "next/navigation";
import { adminEmailForCustomer, isAdminEmail } from "@/auth/admin";
import { sessionCustomerId, withSessionDeps } from "@/auth/request-session";
import { ProviderSettingsForm } from "@/components/monitor/cari/provider-settings-form";
import { withCustomer } from "@/db/migrate";
import { withClient } from "@/db/pg";
import { loadProviderSettingRows } from "@/monitor/search/provider-settings";
import {
  saveProviderSettingAction,
  type ProviderSettingActionInput,
} from "./actions";

async function Body() {
  const customerId = await sessionCustomerId();
  if (!customerId) redirect("/masuk");

  const data = await withClient(async (db) => {
    const email = await withCustomer(db, customerId, () =>
      adminEmailForCustomer(db, customerId),
    );
    if (!isAdminEmail(email)) return { authorized: false as const };
    return { authorized: true as const, rows: await loadProviderSettingRows(db) };
  });

  if (!data.authorized) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold text-foreground">Pengaturan penyedia</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Anda tidak berwenang mengubah penyedia pencarian.
        </p>
      </main>
    );
  }

  async function save(input: ProviderSettingActionInput) {
    "use server";
    return withSessionDeps((deps) => saveProviderSettingAction(input, deps));
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Pengaturan penyedia</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mengatur penyedia untuk pencarian langsung dan komentar. Perubahan langsung berlaku.
        </p>
      </div>
      <ProviderSettingsForm rows={data.rows} onSave={save} />
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}
