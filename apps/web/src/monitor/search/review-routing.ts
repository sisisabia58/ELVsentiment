import { randomUUID } from "node:crypto";
import { withCustomer, type Queryable } from "@/db/migrate";
import { readStoredMentions } from "../mention-store";
import type { StoredMention } from "../present";
import { cariSekarangEnabled, type Env } from "./feature";
import type { SnapshotResult } from "./load";
import { admitReviewResult, resolveReviewResult, type ReviewDestination, type ReviewKey } from "./review-result";
import { isUuid } from "./search-id";
import { pantauFilterTriageEnabled } from "./seed-project";

export type ManualRoute = { destination: ReviewDestination | null; revision: string | null };
export type RouteInput = ReviewKey & { destination: ReviewDestination; expectedRevision: string | null; requestId: string };
export type UndoInput = { projectId: string; mentionId: string; revision: string };
type Context = { db: Queryable; customerId: string; env: Env };
type ReviewError = "unauthenticated" | "disabled" | "not_found" | "ineligible" | "conflict";
type Failure = { ok: false; error: ReviewError };
export type ReviewReadResult = Failure | {
  ok: true; evidence: SnapshotResult; mentionId: string | null; triage: NonNullable<StoredMention["triage"]> | null; route: ManualRoute;
};
export type ReviewWriteResult = Failure | { ok: true; mentionId: string; route: ManualRoute };

class Rejected extends Error {
  constructor(readonly code: ReviewError) { super(code); }
}

async function inProject<T>(ctx: Context, projectId: string, action: () => Promise<T>): Promise<T | Failure> {
  if (!cariSekarangEnabled(ctx.env) || !pantauFilterTriageEnabled(ctx.env)) return { ok: false, error: "disabled" };
  if (!isUuid(projectId)) return { ok: false, error: "not_found" };
  try {
    return await withCustomer(ctx.db, ctx.customerId, async () => {
      // Cari resolves requireWorkspace(undefined), whose default is the newest project.
      const result = await ctx.db.query<{ id: string; pantau_filter_triage: boolean }>(
        "select id, pantau_filter_triage from projects where customer_id=$1 order by created_at desc, id limit 1",
        [ctx.customerId]);
      const active = result.rows[0];
      if (active?.id !== projectId) throw new Rejected("not_found");
      if (!active.pantau_filter_triage) throw new Rejected("disabled");
      return action();
    });
  } catch (error) {
    // In particular, roll back a newly admitted mention when CAS fails.
    if (error instanceof Rejected) return { ok: false, error: error.code };
    throw error;
  }
}

async function currentRoute(db: Queryable, mentionId: string): Promise<ManualRoute> {
  const result = await db.query<ManualRoute>("select destination, revision from pantau_manual_routes where mention_id=$1", [mentionId]);
  return result.rows[0] ?? { destination: null, revision: null };
}

export function readCariReview(ctx: Context, key: ReviewKey): Promise<ReviewReadResult> {
  return inProject(ctx, key?.projectId, async () => {
    const review = await resolveReviewResult(ctx.db, ctx.customerId, key);
    if (!review.ok) return review;
    const mention = review.mentionId
      ? (await readStoredMentions(ctx.db, ctx.customerId, { mentionId: review.mentionId }))[0] : undefined;
    if (mention?.correction?.relevance === "irrelevant") throw new Rejected("ineligible");
    return { ...review, triage: mention?.triage ?? null,
      route: review.mentionId ? await currentRoute(ctx.db, review.mentionId) : { destination: null, revision: null } };
  });
}

async function lockMention(ctx: Context, projectId: string, mentionId: string) {
  // The canonical mention exists before the first route. Locking it serializes
  // first writers as well as later routing and Undo across connections.
  const found = await ctx.db.query<{ source: string }>(
    "select source from mentions where id=$1 and customer_id=$2 and project_id=$3 for update",
    [mentionId, ctx.customerId, projectId]);
  if (!found.rows[0]) throw new Rejected("not_found");
  return found.rows[0].source;
}

export function routeCariResult(ctx: Context, input: RouteInput): Promise<ReviewWriteResult> {
  return inProject(ctx, input?.projectId, async () => {
    if (!["attention", "ambiguous"].includes(input.destination) || !isUuid(input.requestId)
      || !(input.expectedRevision === null || isUuid(input.expectedRevision))) throw new Rejected("ineligible");
    const admitted = await admitReviewResult(ctx.db, ctx.customerId, input);
    if (!admitted.ok) throw new Rejected(admitted.error);
    const { mentionId } = admitted;
    const source = await lockMention(ctx, input.projectId, mentionId);
    // A competing transaction may have delayed the lock beyond retention.
    const retained = await resolveReviewResult(ctx.db, ctx.customerId, input);
    if (!retained.ok) throw new Rejected(retained.error);
    if (retained.mentionId !== mentionId) throw new Rejected("ineligible");
    const corrected = await ctx.db.query(
      "select 1 from owner_corrections where mention_id=$1 and customer_id=$2 and relevance='irrelevant'",
      [mentionId, ctx.customerId]);
    if (corrected.rows.length) throw new Rejected("ineligible");
    const route = await currentRoute(ctx.db, mentionId);
    const replay = await ctx.db.query("select 1 from pantau_manual_route_requests where mention_id=$1 and request_id=$2",
      [mentionId, input.requestId]);
    if (replay.rows.length) return { ok: true as const, mentionId, route };
    if (route.revision !== input.expectedRevision) throw new Rejected("conflict");
    const revision = randomUUID();
    await ctx.db.query(`insert into pantau_manual_routes
      (mention_id,customer_id,project_id,source,destination,routed_at,revision,undoable)
      values ($1,$2,$3,$4,$5,clock_timestamp(),$6,true)
      on conflict (mention_id) do update set
        previous_destination=pantau_manual_routes.destination, previous_routed_at=pantau_manual_routes.routed_at,
        destination=excluded.destination, routed_at=excluded.routed_at, revision=excluded.revision, undoable=true`,
      [mentionId, ctx.customerId, input.projectId, source, input.destination, revision]);
    await ctx.db.query("insert into pantau_manual_route_requests (mention_id,customer_id,request_id) values ($1,$2,$3)",
      [mentionId, ctx.customerId, input.requestId]);
    return { ok: true as const, mentionId, route: { destination: input.destination, revision } };
  });
}

export function undoCariRoute(ctx: Context, input: UndoInput): Promise<ReviewWriteResult> {
  return inProject(ctx, input?.projectId, async () => {
    if (!isUuid(input.mentionId) || !isUuid(input.revision)) throw new Rejected("not_found");
    await lockMention(ctx, input.projectId, input.mentionId);
    const restored = await ctx.db.query<ManualRoute>(`update pantau_manual_routes
      set destination=previous_destination, routed_at=previous_routed_at, previous_destination=null,
          previous_routed_at=null, revision=$4, undoable=false
      where mention_id=$1 and customer_id=$2 and project_id=$3 and revision=$5 and undoable
      returning destination, revision`, [input.mentionId, ctx.customerId, input.projectId, randomUUID(), input.revision]);
    if (!restored.rows.length) throw new Rejected("conflict");
    return { ok: true as const, mentionId: input.mentionId, route: restored.rows[0] };
  });
}
