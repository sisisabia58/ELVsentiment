import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import type { SourceId } from "../monitor/policy";

export async function ingestMention(
  db: Queryable,
  input: {
    customerId: string;
    projectId: string;
    source: SourceId;
    externalId: string;
    variant: string;
    excerpt: string;
    url: string | null;
    author: string | null;
    postedAt: string;
  },
): Promise<{ id: string; result: "inserted" | "deduped" }> {
  return withCustomer(db, input.customerId, async () => {
    const existing = await db.query<{ id: string; matched_variants: string[] }>(
      "select id, matched_variants from mentions where customer_id = $1 and project_id = $2 and source = $3 and external_id = $4",
      [input.customerId, input.projectId, input.source, input.externalId],
    );
    if (existing.rows[0]) {
      const variants = existing.rows[0].matched_variants.includes(input.variant)
        ? existing.rows[0].matched_variants
        : [...existing.rows[0].matched_variants, input.variant];
      await db.query("update mentions set matched_variants = $1 where id = $2 and customer_id = $3 and project_id = $4", [
        variants,
        existing.rows[0].id,
        input.customerId,
        input.projectId,
      ]);
      return { id: existing.rows[0].id, result: "deduped" as const };
    }
    const id = randomUUID();
    await db.query(
      `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, 'pending')`,
      [id, input.customerId, input.projectId, input.source, input.externalId, input.excerpt, input.url, input.author, input.postedAt, [input.variant]],
    );
    return { id, result: "inserted" as const };
  });
}

export const insertMention = ingestMention;
