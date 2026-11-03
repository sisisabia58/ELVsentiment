import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import { effectOfKeywordEdit } from "../domain/keyword-history";
import { generateCandidates, validateVariantList } from "../domain/variants";
import { workingSources, type SourceCredentials } from "../monitor/onboarding-draft";
import { applySchedule, normalizeSchedule, readLimits, type ScheduleLimits } from "./schedules";
import type { ScheduleChoice } from "../monitor/schedule-choice";
import { toPersist } from "../monitor/schedule-choice";

export async function createProject(
  db: Queryable,
  customerId: string,
  brandName: string,
): Promise<{ projectId: string; candidates: string[] }> {
  const projectId = randomUUID();
  await withCustomer(db, customerId, async () => {
    await db.query(
      "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, $3, now())",
      [projectId, customerId, brandName.trim()],
    );
    await db.query(
      "insert into project_settings (project_id, customer_id, source_filter) values ($1, $2, 'all')",
      [projectId, customerId],
    );
  });
  return { projectId, candidates: generateCandidates(brandName) };
}

export type ExistingProject = { projectId: string; brandName: string; candidates: string[]; selected: string[] };

export async function latestProject(db: Queryable, customerId: string): Promise<ExistingProject | null> {
  return withCustomer(db, customerId, async () => {
    const found = await db.query<{ id: string; brand_name: string }>(
      "select id, brand_name from projects order by created_at desc, id limit 1",
    );
    const project = found.rows[0];
    if (!project) return null;
    const variants = await db.query<{ text: string; active: boolean }>(
      "select text, active from keyword_variants where project_id = $1 order by created_at, text",
      [project.id],
    );
    const candidates = generateCandidates(project.brand_name);
    for (const { text } of variants.rows) if (!candidates.includes(text)) candidates.push(text);
    return {
      projectId: project.id,
      brandName: project.brand_name,
      candidates,
      selected: variants.rows.filter((row) => row.active).map((row) => row.text),
    };
  });
}

// Foreign keys bypass RLS, so an insert that names another customer's project
// id would pass the tenant WITH CHECK. Callers taking a project id must check it.
export async function ownsProject(db: Queryable, customerId: string, projectId: string): Promise<boolean> {
  const found = await withCustomer(db, customerId, () =>
    db.query<{ id: string }>("select id from projects where id = $1", [projectId]),
  );
  return found.rows.length === 1;
}

export async function saveActiveVariants(
  db: Queryable,
  customerId: string,
  projectId: string,
  variants: string[],
  rescore: (mentionIds: string[]) => Promise<void>,
): Promise<
  | { ok: true; active: string[] }
  | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string }
> {
  const validated = validateVariantList(variants);
  if (!validated.ok) return validated;
  const effect = effectOfKeywordEdit(validated.variants);
  if (effect.reclassifyExisting) {
    await rescore([]);
  }
  await withCustomer(db, customerId, () => replaceActiveVariants(db, customerId, projectId, effect.futureQueries));
  return { ok: true, active: [...effect.futureQueries] };
}

async function replaceActiveVariants(
  db: Queryable,
  customerId: string,
  projectId: string,
  texts: readonly string[],
): Promise<void> {
  await db.query("update keyword_variants set active = false where project_id = $1 and customer_id = $2", [
    projectId,
    customerId,
  ]);
  for (const text of texts) {
    await db.query(
      `insert into keyword_variants (id, customer_id, project_id, text, active, created_at)
       values ($1, $2, $3, $4, true, now())
       on conflict (project_id, text) do update set active = true`,
      [randomUUID(), customerId, projectId, text],
    );
  }
}

export async function saveProjectConfiguration(
  db: Queryable,
  customerId: string,
  input: {
    projectId: string;
    brandName: string;
    variants: string[];
    sources: ("x" | "threads")[];
    schedule: ScheduleChoice;
    now?: Date;
  },
  limits: ScheduleLimits = readLimits(),
  // Fail closed. The settings action passes sourceCredentials(); a caller that
  // omits them must not store X or Threads.
  credentials: SourceCredentials = { x: false, threads: false },
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const sources = workingSources(input.sources, credentials);
  const anyConfigured = credentials.x || credentials.threads;
  if (!input.brandName.trim()) return { ok: false, error: "Masukkan nama merek." };
  if (anyConfigured && sources.length === 0) return { ok: false, error: "Pilih setidaknya satu sumber." };
  const validated = validateVariantList(input.variants);
  if (!validated.ok) {
    if (validated.reason === "duplicate") return { ok: false, error: "Variasi ini sudah ditambahkan." };
    if (validated.reason === "empty") return { ok: false, error: "Masukkan variasi kata kunci." };
    return { ok: false, error: "Variasi kata kunci terlalu panjang." };
  }
  const schedule = normalizeSchedule({ ...toPersist(input.schedule), now: input.now }, limits);
  if (!schedule.ok) return { ok: false, error: "Jarak jadwal minimal 6 jam." };
  const texts = effectOfKeywordEdit(validated.variants).futureQueries;
  return withCustomer(db, customerId, async () => {
    const owned = await db.query<{ id: string }>("select id from projects where id = $1", [input.projectId]);
    if (owned.rows.length !== 1) {
      return { ok: false as const, error: "Halaman tidak ditemukan atau Anda tidak memiliki akses." };
    }
    await db.query("update projects set brand_name = $1 where id = $2", [input.brandName.trim(), input.projectId]);
    await replaceActiveVariants(db, customerId, input.projectId, texts);
    await db.query("update project_settings set enabled_sources = $1 where project_id = $2", [
      sources,
      input.projectId,
    ]);
    await applySchedule(db, customerId, input.projectId, schedule.value);
    return {
      ok: true as const,
      message: "Perubahan berlaku untuk pengumpulan berikutnya. Data dan penilaian sebelumnya tidak diubah.",
    };
  });
}
