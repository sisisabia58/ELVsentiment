// Dev-only fixture for local screenshots. Not imported by the Next.js app.
// Run: node --experimental-strip-types scripts/seed-screenshots.mts
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { registerOwner } from "../src/auth/accounts.ts";
import { createProject } from "../src/projects/handlers.ts";
import { jakartaDate } from "../src/monitor/range.ts";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

const PASSWORD = "sandi-panjang-sekali";

function shift(daysBack: number, hourWib: number): string {
  const today = jakartaDate(new Date());
  const [year, month, date] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() - daysBack);
  const day = utc.toISOString().slice(0, 10);
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hourWib - 7, 15, 0)).toISOString();
}

type MentionSeed = {
  id: string;
  source: "x" | "threads";
  excerpt: string;
  author: string;
  postedAt: string;
  status: "pending" | "succeeded" | "failed";
  correction?: { action: "confirm" | "correct"; relevance: "relevant" | "irrelevant"; sentiment: "positive" | "neutral" | "negative" | null };
  attention?: boolean;
  read?: boolean;
};

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("truncate table customers cascade");
const db = {
  async query<T>(sql: string, params: unknown[] = []) {
    const result = await client.query(sql, params);
    return { rows: result.rows as T[] };
  },
  async exec(sql: string) {
    await client.query(sql);
  },
};

const owner = await registerOwner(db, {
  email: "rina@pakgembus.example",
  password: PASSWORD,
  displayName: "Rina Wulandari",
});
const project = await createProject(db, owner.customerId, "Ayam Geprek Pak Gembus");
const emptyOwner = await registerOwner(db, {
  email: "kosong@contoh.example",
  password: PASSWORD,
  displayName: "Budi Santoso",
});
const emptyProject = await createProject(db, emptyOwner.customerId, "Kedai Contoh");
const fresh = await registerOwner(db, {
  email: "baru@contoh.example",
  password: PASSWORD,
  displayName: "Sari Lestari",
});

const mentions: MentionSeed[] = [
  { id: randomUUID(), source: "x", excerpt: "Porsi ayam gepreknya besar dan sambalnya pas. Saya pesan lagi minggu depan.", author: "Dina", postedAt: shift(0, 9), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "positive" } },
  { id: randomUUID(), source: "threads", excerpt: "Antrian siang ini lancar. Ayamnya renyah dan tidak terlalu berminyak.", author: "Fajar", postedAt: shift(1, 14), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "positive" } },
  { id: randomUUID(), source: "x", excerpt: "Mampir setelah rapat. Rasa tetap sama, porsi konsisten.", author: "Maya", postedAt: shift(2, 11), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "positive" } },
  { id: randomUUID(), source: "threads", excerpt: "Paket keluarga cukup untuk empat orang. Harganya masuk akal.", author: "Andi", postedAt: shift(3, 16), status: "succeeded", correction: { action: "correct", relevance: "relevant", sentiment: "positive" } },
  { id: randomUUID(), source: "x", excerpt: "Lokasinya mudah dicari. Saya hanya mampir sebentar.", author: "Sinta", postedAt: shift(4, 10), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "neutral" } },
  { id: randomUUID(), source: "threads", excerpt: "Menu hari ini sama seperti biasanya. Tidak ada yang istimewa.", author: "Raka", postedAt: shift(5, 18), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "neutral" } },
  { id: randomUUID(), source: "x", excerpt: "Pesanan saya terlambat dan ayamnya sudah dingin. Kecewa.", author: "Laras", postedAt: shift(6, 12), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "negative" }, attention: true },
  { id: randomUUID(), source: "threads", excerpt: "Kemarin antreannya panjang dan sambalnya habis.", author: "Gilang", postedAt: shift(8, 9), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "negative" }, attention: true, read: true },
  { id: randomUUID(), source: "x", excerpt: "Cabang ini lebih sepi, tapi pesanan tertukar.", author: "Hana", postedAt: shift(10, 13), status: "succeeded", correction: { action: "correct", relevance: "relevant", sentiment: "negative" }, attention: true, read: true },
  { id: randomUUID(), source: "threads", excerpt: "Layanannya lambat sekali sore itu.", author: "Omar", postedAt: shift(12, 19), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "negative" }, attention: true, read: true },
  { id: randomUUID(), source: "x", excerpt: "Datang lagi karena rasanya cocok dengan keluarga.", author: "Nina", postedAt: shift(11, 8), status: "succeeded", correction: { action: "confirm", relevance: "relevant", sentiment: "positive" } },
  { id: randomUUID(), source: "x", excerpt: "Baru melihat unggahan ini, penilaiannya belum selesai.", author: "Tia", postedAt: shift(0, 8), status: "pending" },
  { id: randomUUID(), source: "threads", excerpt: "Unggahan ini gagal dinilai dan belum saya periksa.", author: "Yusuf", postedAt: shift(0, 7), status: "failed" },
  { id: randomUUID(), source: "x", excerpt: "Ada yang membahas menu ayam di dekat kantor, belum saya konfirmasi.", author: "Wulan", postedAt: shift(1, 20), status: "succeeded" },
];

const attentionId = mentions.find((mention) => mention.attention && !mention.read)?.id;

async function asCustomer(customerId: string, fn: () => Promise<void>) {
  await client.query("begin");
  await client.query("select set_config('app.customer_id', $1, true)", [customerId]);
  await client.query("set local role app_user");
  await fn();
  await client.query("commit");
}

await asCustomer(owner.customerId, async () => {
  for (const text of ["ayam geprek pak gembus", "geprek gembus", "geprek pak gembus"]) {
    await client.query(
      `insert into keyword_variants (id, customer_id, project_id, text, active, created_at)
       values ($1, $2, $3, $4, true, now())`,
      [randomUUID(), owner.customerId, project.projectId, text],
    );
  }
  await client.query(
    `insert into project_schedules (project_id, customer_id, enabled, interval_hours, time_zone, cadence, next_run_at, last_collected_at)
     values ($1, $2, true, 12, 'Asia/Jakarta', 'interval', now() + interval '12 hours', now() - interval '2 hours')`,
    [project.projectId, owner.customerId],
  );
  for (const mention of mentions) {
    await client.query(
      `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status, read_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,array['ayam geprek pak gembus'],$10,$11)`,
      [
        mention.id,
        owner.customerId,
        project.projectId,
        mention.source,
        mention.id,
        mention.excerpt,
        mention.source === "x" ? `https://x.com/warga/status/${mention.id.slice(0, 8)}` : `https://www.threads.net/@warga/post/${mention.id.slice(0, 8)}`,
        mention.author,
        mention.postedAt,
        mention.status,
        mention.read ? mention.postedAt : null,
      ],
    );
    if (mention.status === "succeeded") {
      await client.query(
        `insert into jev_results (mention_id, customer_id, provider, model, raw_response, relevance_noul, sentiment, sentiment_confidence, topic_nouls, created_at)
         values ($1,$2,'typesafe','seed','{}',0.7,$3,0.4,'[]',now())`,
        [mention.id, owner.customerId, mention.correction?.sentiment ?? "neutral"],
      );
    }
    if (mention.correction) {
      await client.query(
        `insert into owner_corrections (mention_id, customer_id, action, relevance, sentiment, topics, created_at)
         values ($1,$2,$3,$4,$5,'{}',now())`,
        [mention.id, owner.customerId, mention.correction.action, mention.correction.relevance, mention.correction.sentiment],
      );
    }
    if (mention.attention) {
      await client.query(
        `insert into attention_items (id, customer_id, mention_id, reason, unread, seen_at, created_at)
         values ($1,$2,$3,'negative',$4,$5,now())`,
        [randomUUID(), owner.customerId, mention.id, !mention.read, mention.read ? mention.postedAt : null],
      );
    }
  }
  await client.query(
    `insert into jobs (id, customer_id, project_id, kind, status, status_detail, run_after, created_at)
     values ($1,$2,$3,'scheduled','failed',null,now() - interval '3 days', now() - interval '3 days'),
            ($4,$2,$3,'manual','succeeded',null,now() - interval '2 hours', now() - interval '2 hours'),
            ($5,$2,$3,'manual','deferred','skipped_overlap',now() - interval '1 hour', now() - interval '1 hour')`,
    [randomUUID(), owner.customerId, project.projectId, randomUUID(), randomUUID()],
  );
  await client.query(
    `insert into source_status (customer_id, project_id, source, state, detail, last_success_at, updated_at)
     values ($1,$2,'x','ready','',now() - interval '2 hours', now()),
            ($1,$2,'threads','ready','',now() - interval '2 hours', now())`,
    [owner.customerId, project.projectId],
  );
});

await asCustomer(emptyOwner.customerId, async () => {
  await client.query(
    `insert into keyword_variants (id, customer_id, project_id, text, active, created_at) values ($1,$2,$3,'kedai contoh',true,now())`,
    [randomUUID(), emptyOwner.customerId, emptyProject.projectId],
  );
  await client.query(
    `insert into project_schedules (project_id, customer_id, enabled, interval_hours, time_zone, cadence)
     values ($1,$2,false,6,'Asia/Jakarta','interval')`,
    [emptyProject.projectId, emptyOwner.customerId],
  );
});

await client.query(
  `insert into worker_heartbeat (id, worker_id, last_seen_at) values (1, 'seed', now())
   on conflict (id) do update set last_seen_at = now()`,
);

const review = mentions.find((mention) => mention.id === attentionId);
writeFileSync(
  "/tmp/seed-screenshots.json",
  JSON.stringify(
    {
      password: PASSWORD,
      populated: { email: "rina@pakgembus.example", projectId: project.projectId, reviewId: review?.id },
      empty: { email: "kosong@contoh.example", projectId: emptyProject.projectId },
      fresh: { email: "baru@contoh.example" },
    },
    null,
    2,
  ),
);
await client.end();
console.log("seeded", project.projectId, review?.id);
