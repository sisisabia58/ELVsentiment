import { redirect } from "next/navigation";
import { platformAdminForSession, sessionTokenHash } from "@/auth/admin";
import { readSessionToken, sessionCustomerId } from "@/auth/request-session";
import { withClient } from "@/db/pg";
import { loadWorkspace, type Workspace } from "./load";
import { readLimits } from "../projects/schedules";

export async function requireWorkspace(projectId: string | undefined): Promise<{
  customerId: string;
  now: Date;
  workspace: Workspace;
}> {
  const customerId = await sessionCustomerId();
  if (!customerId) redirect("/masuk");
  const now = new Date();
  const token = await readSessionToken();
  const isAdmin = token
    ? await withClient((db) =>
        platformAdminForSession(db, customerId, sessionTokenHash(token))
          .then((admin) => admin !== null)
          .catch(() => false),
      )
    : false;
  const workspace = await withClient((db) =>
    loadWorkspace(db, customerId, projectId, now, readLimits(), isAdmin),
  );
  return { customerId, now, workspace };
}
