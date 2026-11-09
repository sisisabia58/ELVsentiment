import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import { parseKeyword, type Keyword, type KeywordIntent } from "../domain/keyword-intent";
import { effectOfKeywordEdit } from "../domain/keyword-history";
import { generateCandidates, normalizeVariant, validateVariantList } from "../domain/variants";
import { asSources, workingSources, type SourceCredentials, type SourceId } from "../monitor/onboarding-draft";
import { applySchedule, normalizeSchedule, readLimits, type ScheduleLimits } from "./schedules";
import type { ScheduleChoice } from "../monitor/schedule-choice";
import { toPersist } from "../monitor/schedule-choice";

export type KeywordInput = string | { text: string; intent: KeywordIntent };

function asKeywords(values: readonly KeywordInput[]): Keyword[] {
  return values.map((value) => {
    if (typeof value === "string") {
      return parseKeyword(normalizeVariant(value));
    }
    return { text: normalizeVariant(value.text), intent: value.intent };
  });
}

function withIntents(texts: readonly string[], keywords: readonly Keyword[]): Keyword[] {
  const intents = new Map(keywords.map((keyword) => [keyword.text, keyword.intent]));
  return texts.map((text) => ({ text, intent: intents.get(text) ?? "phrase" }));
}

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
  variants: KeywordInput[],
  rescore: (mentionIds: string[]) => Promise<void>,
): Promise<
  | { ok: true; active: string[] }
  | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string }
> {
  const keywords = asKeywords(variants);
  const validated = validateVariantList(keywords.map((keyword) => keyword.text));
  if (!validated.ok) return validated;
  const effect = effectOfKeywordEdit(validated.variants);
  if (effect.reclassifyExisting) {
    await rescore([]);
  }
  const resolved = withIntents(effect.futureQueries, keywords);
  await withCustomer(db, customerId, () => replaceActiveVariants(db, customerId, projectId, resolved));
  return { ok: true, active: [...effect.futureQueries] };
}

async function replaceActiveVariants(
  db: Queryable,
  customerId: string,
  projectId: string,
  keywords: readonly Keyword[],
): Promise<void> {
  await db.query("update keyword_variants set active = false where project_id = $1 and customer_id = $2", [
    projectId,
    customerId,
  ]);
  for (const keyword of keywords) {
    await db.query(
      `insert into keyword_variants (id, customer_id, project_id, text, active, created_at, intent)
       values ($1, $2, $3, $4, true, now(), $5)
       on conflict (project_id, text) do update
         set active = true, text = excluded.text, intent = excluded.intent`,
      [randomUUID(), customerId, projectId, keyword.text, keyword.intent],
    );
  }
}

export async function saveProjectSources(
  db: Queryable,
  customerId: string,
  projectId: string,
  sources: readonly SourceId[],
): Promise<{ ok: true; sources: SourceId[] } | { ok: false; error: string }> {
  const valid = asSources(sources);
  if (valid.length === 0) return { ok: false, error: "Pilih setidaknya satu sumber." };
  return withCustomer(db, customerId, async () => {
    const owned = await db.query<{ id: string }>("select id from projects where id = $1", [projectId]);
    if (owned.rows.length !== 1) {
      return { ok: false as const, error: "Halaman tidak ditemukan atau Anda tidak memiliki akses." };
    }
    await db.query("update project_settings set enabled_sources = $1 where project_id = $2", [valid, projectId]);
    return { ok: true as const, sources: valid };
  });
}

export async function saveProjectConfiguration(
  db: Queryable,
  customerId: string,
  input: {
    projectId: string;
    brandName: string;
    variants: KeywordInput[];
    sources: SourceId[];
    schedule: ScheduleChoice;
    now?: Date;
  },
  limits: ScheduleLimits = readLimits(),
  // Fail closed. The settings action passes sourceCredentials(); a caller that
  // omits them must not store X or Threads.
  credentials: SourceCredentials = { x: false, threads: false, instagram: false, tiktok: false },
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const sources = workingSources(input.sources, credentials);
  const anyConfigured = Boolean(
    credentials.x || credentials.threads || credentials.instagram || credentials.tiktok,
  );
  if (!input.brandName.trim()) return { ok: false, error: "Masukkan nama merek." };
  if (anyConfigured && sources.length === 0) return { ok: false, error: "Pilih setidaknya satu sumber." };
  const keywords = asKeywords(input.variants);
  const validated = validateVariantList(keywords.map((keyword) => keyword.text));
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
    await replaceActiveVariants(db, customerId, input.projectId, withIntents(texts, keywords));
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
