"use server";

import { withSessionDeps } from "@/auth/request-session";
import { createProjectAction, saveVariantsAction } from "./actions";

export async function createProjectForSession(brandName: string) {
  return withSessionDeps((deps) => createProjectAction(String(brandName), deps));
}

export async function saveVariantsForSession(projectId: string, variants: string[]) {
  const list = Array.isArray(variants) ? variants.map(String) : [];
  return withSessionDeps((deps) => saveVariantsAction(String(projectId), list, deps));
}
