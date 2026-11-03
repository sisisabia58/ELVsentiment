import { redirect } from "next/navigation";
import { sessionCustomerId } from "@/auth/request-session";
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
  const workspace = await withClient((db) => loadWorkspace(db, customerId, projectId, now, readLimits()));
  return { customerId, now, workspace };
}
