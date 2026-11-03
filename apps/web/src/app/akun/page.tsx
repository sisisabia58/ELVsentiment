import { Suspense } from "react";
import { LogoutForm } from "@/components/logout-form";
import { PageHeader, Panel } from "@/components/monitor/bits";
import { ProfileForm } from "@/components/monitor/profile-form";
import { Frame } from "@/components/monitor/shell";
import { requireWorkspace } from "@/monitor/session-page";

async function Body() {
  const { workspace } = await requireWorkspace(undefined);
  return (
    <Frame active="/akun" workspace={workspace} logout={<LogoutForm />}>
      <PageHeader title="Profil" subtitle="Akun pemilik." />
      <div className="mt-6 max-w-lg">
        <Panel title="Profil" subtitle="Email akun tidak dapat diubah di sini.">
          <ProfileForm name={workspace.displayName} email={workspace.email} />
        </Panel>
      </div>
    </Frame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}
