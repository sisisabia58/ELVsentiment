import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, withCustomer } from "@/db/migrate";
import { readStoredMentions } from "../mention-store";
import { saveMentionReview } from "../mutations";
import { readMonitorPolicy } from "../policy";
import { presentMention } from "../present";
import { createProject, saveProjectConfiguration } from "@/projects/handlers";
import { readCariReview, routeCariResult, undoCariRoute } from "./review-routing";

const pg = new PGlite();
const db = pgliteQueryable(pg);
const customerId = randomUUID();
const env = { CARI_SEKARANG_ENABLED: "1", PANTAU_FILTER_TRIAGE_ENABLED: "1" };
const ctx = { db, customerId, env };
const searchId = randomUUID();
let projectId: string;
async function key() {
  const resultId = randomUUID();
  await db.query(`insert into instant_search_results
    (id,search_id,customer_id,platform,external_id,text,relevance,source_provider,web_index,raw_ref,rank)
    values ($1,$2,$3,'threads',$4,'Tukuliling dingin','literal_match','scrapecreators',false,'fixture',1)`,
    [resultId, searchId, customerId, resultId]);
  return { projectId, searchId, resultId };
}
beforeAll(async () => {
  await applyMigration(db);
  await db.query("insert into customers (id,customer_id,created_at) values ($1,$1,now())", [customerId]);
  projectId = (await createProject(db, customerId, "Tukuliling")).projectId;
  await saveProjectConfiguration(db, customerId, { projectId, brandName: "Tukuliling", variants: ["tukuliling"],
    sources: ["threads"], schedule: { mode: "off", intervalHours: 6 } }, undefined, { x: false, threads: true });
  await db.query("update projects set pantau_filter_triage=true where id=$1", [projectId]);
  await db.query(`insert into instant_searches (id,customer_id,query_text,keyword_intent,date_window,sort_mode,
    language_filter,status,finished_at,deadline_at,retention_expires_at,relevance_version)
    values ($1,$2,'tukuliling','phrase','all','relevance','all','succeeded',now(),now(),now()+interval '1 day',1)`, [searchId,customerId]);
  await db.query(`insert into instant_search_sources (search_id,customer_id,platform,provider,state)
    values ($1,$2,'threads','scrapecreators','answered')`, [searchId,customerId]);
}, 30000);
afterAll(() => pg.close());

it("reads without importing, rolls back failed admission-plus-CAS and enforces feature access", async () => {
  const k = await key();
  expect(await readCariReview(ctx, k)).toMatchObject({ ok: true, mentionId: null, route: { destination: null, revision: null } });
  expect(await readCariReview({ ...ctx, env: {} }, k)).toEqual({ ok: false, error: "disabled" });
  expect(await routeCariResult(ctx, { ...k, destination: "attention", expectedRevision: randomUUID(), requestId: randomUUID() }))
    .toEqual({ ok: false, error: "conflict" });
  expect(await readCariReview(ctx, k)).toMatchObject({ ok: true, mentionId: null });
});

it("requires the opted-in current project and blocks an irrelevant owner correction", async () => {
  const k = await key();
  await db.query("update projects set pantau_filter_triage=false where id=$1", [projectId]);
  expect(await readCariReview(ctx, k)).toEqual({ ok: false, error: "disabled" });
  await db.query("update projects set pantau_filter_triage=true where id=$1", [projectId]);
  const input = { ...k, destination: "attention" as const, expectedRevision: null, requestId: randomUUID() };
  const initial = await routeCariResult(ctx, input);
  if (!initial.ok) throw new Error(initial.error);
  const [stored] = await withCustomer(db, customerId, () => readStoredMentions(db, customerId, { mentionId: initial.mentionId }));
  expect(stored.manualRoute).toMatchObject({ destination: "attention", routedAt: expect.any(String) });
  await db.query(`insert into owner_corrections (mention_id,customer_id,action,relevance,topics,created_at)
    values ($1,$2,'correct','irrelevant','{}',now())`, [initial.mentionId, customerId]);
  expect(await readCariReview(ctx, k)).toEqual({ ok: false, error: "ineligible" });
  expect(await routeCariResult(ctx, { ...input, expectedRevision: initial.route.revision, requestId: randomUUID() }))
    .toEqual({ ok: false, error: "ineligible" });

  expect(await routeCariResult(ctx, input)).toEqual({ ...initial, replayed: true });

  const other = (await createProject(db, customerId, "Another")).projectId;
  expect(await readCariReview(ctx, k)).toEqual({ ok: false, error: "not_found" });
  await db.query("update projects set created_at=created_at-interval '1 day' where id=$1", [other]);
});

async function routeAssessedMention(destination: "attention" | "ambiguous", automaticallyAmbiguous = false) {
  const routed = await routeCariResult(ctx, { ...await key(), destination, expectedRevision: null, requestId: randomUUID() });
  if (!routed.ok || !routed.route.revision) throw new Error("Test route was not saved");
  const { mentionId } = routed;
  await db.query(`insert into pantau_triage_jobs (mention_id,customer_id,project_id,source,status)
    values ($1,$2,$3,'threads','completed')
    on conflict (mention_id) do update set status=excluded.status`, [mentionId, customerId, projectId]);
  await db.query(`insert into pantau_triage_judgments
    (mention_id,customer_id,project_id,destination,origin,relevance_tier,sentiment,actionability,reason,model_version)
    values ($1,$2,$3,$4,'opencode','literal_match','negative','not_actionable',$5,'fixture')`,
    [mentionId, customerId, projectId, automaticallyAmbiguous ? "ambiguous" : "mention",
      automaticallyAmbiguous ? "complaint_unclear" : "non_actionable"]);
  return { mentionId, revision: routed.route.revision };
}

async function presentedMention(mentionId: string) {
  const [stored] = await withCustomer(db, customerId, () => readStoredMentions(db, customerId, { mentionId }));
  return presentMention(stored, readMonitorPolicy().scoring);
}

const confirmNegative = { relevance: "relevant", sentiment: "negative" } as const;

it("does not leave an attention item after confirmation and Undo of manual attention", async () => {
  const route = await routeAssessedMention("attention");
  expect(await presentedMention(route.mentionId)).toMatchObject({ needsAttention: true });
  expect(await saveMentionReview(db, customerId, route.mentionId, { ...confirmNegative, topics: [] }))
    .toEqual({ ok: true, action: "confirm" });
  expect(await undoCariRoute(ctx, { projectId, ...route })).toMatchObject({ ok: true, route: { destination: null } });
  expect(await presentedMention(route.mentionId)).toMatchObject({
    bucket: "included", confirmed: true, needsAttention: false, attentionId: null,
  });
});

it("accepts confirmation and topic changes for an assessed mention manually routed to ambiguity", async () => {
  const { mentionId } = await routeAssessedMention("ambiguous");
  expect(await presentedMention(mentionId)).toMatchObject({ bucket: "not_sure", requiresAssessmentChange: false });
  expect(await saveMentionReview(db, customerId, mentionId, { ...confirmNegative, topics: [] }))
    .toEqual({ ok: true, action: "confirm" });
  expect(await saveMentionReview(db, customerId, mentionId, { ...confirmNegative, topics: ["lainnya"] }))
    .toEqual({ ok: true, action: "correct" });
});

it("requires a changed assessment for an automatically uncertain mention manually routed to attention", async () => {
  const { mentionId } = await routeAssessedMention("attention", true);
  expect(await presentedMention(mentionId)).toMatchObject({ bucket: "included", requiresAssessmentChange: true });
  expect(await saveMentionReview(db, customerId, mentionId, { ...confirmNegative, topics: [] }))
    .toEqual({ ok: false, reason: "invalid" });
});

it("replays requests, restores a previous choice and clears the first choice after expiry", async () => {
  const k = await key();
  const input = { ...k, destination: "attention" as const, expectedRevision: null, requestId: randomUUID() };
  const first = await routeCariResult(ctx, input);
  if (!first.ok) throw new Error(first.error);
  expect(await routeCariResult(ctx, input)).toEqual(first);
  const second = await routeCariResult(ctx, { ...input, destination: "ambiguous", expectedRevision: first.route.revision, requestId: randomUUID() });
  if (!second.ok) throw new Error(second.error);
  expect(await routeCariResult(ctx,input)).toEqual({ ...second, replayed: true });
  const undo = { projectId, mentionId: first.mentionId, revision: second.route.revision! };
  const restored = await undoCariRoute(ctx, undo);
  expect(restored).toMatchObject({ ok: true, route: { destination: "attention" } });
  expect(await undoCariRoute(ctx, undo)).toEqual({ ok: false, error: "conflict" });
  const other = await routeCariResult(ctx, { ...input, ...await key(), requestId: randomUUID() });
  if (!other.ok) throw new Error(other.error);
  await db.query("update instant_searches set retention_expires_at=now() where id=$1", [searchId]);
  expect(await routeCariResult(ctx, input)).toEqual({ ok: false, error: "not_found" });
  const cleared = await undoCariRoute(ctx, { projectId, mentionId: other.mentionId, revision: other.route.revision! });
  expect(cleared).toMatchObject({ ok: true, route: { destination: null, revision: expect.any(String) } });
});
