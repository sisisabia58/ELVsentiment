import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject } from "../projects/handlers";
import { ingestMention } from "./mentions";

describe("mention ingestion", () => {
  it("keeps the same post in two projects of one customer and unions variants per project", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "ingest@example.com", password: "sandi-panjang" });
    const first = await createProject(db, owner.customerId, "Kopi Satu");
    const second = await createProject(db, owner.customerId, "Kopi Dua");
    const base = {
      customerId: owner.customerId,
      source: "threads" as const,
      externalId: "same-post",
      excerpt: "#Kopi",
      url: null,
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    };
    await ingestMention(db, { ...base, projectId: first.projectId, variant: "kopi" });
    const secondInsert = await ingestMention(db, { ...base, projectId: second.projectId, variant: "#kopi" });
    expect(secondInsert.result).toBe("inserted");
    const repeated = await ingestMention(db, { ...base, projectId: first.projectId, variant: "#kopi" });
    expect(repeated.result).toBe("deduped");
    const rows = await withCustomer(db, owner.customerId, () =>
      db.query<{ project_id: string; matched_variants: string[] }>(
        "select project_id, matched_variants from mentions where external_id = 'same-post' order by project_id",
      ),
    );
    expect(rows.rows).toHaveLength(2);
    const firstRow = rows.rows.find((row) => row.project_id === first.projectId);
    expect(firstRow?.matched_variants.sort()).toEqual(["#kopi", "kopi"]);
  });
});
