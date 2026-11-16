// Dev-only screenshot fixture for Cari sekarang. Not imported by the Next.js app.
//
// Destructive: it truncates customers cascade in the target database, like
// scripts/seed-screenshots.mts. Point it at a disposable database where
// migrations 001-012 have already run. It does NOT run migrations and does NOT
// start a dev server or browser.
//
// Run:
//   MIGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:55516/postgres \
//   SCREENSHOT_OUT=/tmp/seed-cari-screenshots.json \
//   node --experimental-strip-types --import ./scripts/ts-resolve-loader.mjs \
//     scripts/seed-cari-screenshots.mts
//
// It writes the owner email/password plus the completed and running search ids
// to SCREENSHOT_OUT for the screenshot harness. All data is synthetic and every
// media URL uses example.invalid.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { registerOwner } from "../src/auth/accounts.ts";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
const out = process.env.SCREENSHOT_OUT;
if (!out) throw new Error("SCREENSHOT_OUT is required");

const EMAIL = "cari-screenshots@example.invalid";
const PASSWORD = "sandi-cari-contoh";
const DISPLAY_NAME = "Tim Cari";

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
  email: EMAIL,
  password: PASSWORD,
  displayName: DISPLAY_NAME,
});

function ago(input: { days?: number; hours?: number; minutes?: number; seconds?: number }): string {
  const ms =
    ((input.days ?? 0) * 24 * 60 * 60 +
      (input.hours ?? 0) * 60 * 60 +
      (input.minutes ?? 0) * 60 +
      (input.seconds ?? 0)) *
    1000;
  return new Date(Date.now() - ms).toISOString();
}

function from(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

type SearchSeed = {
  id: string;
  query: string;
  status: "queued" | "running" | "partial" | "succeeded" | "failed";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stance: string | null;
  credits: number;
  summaryStatus: "pending" | "running" | "done" | "failed" | "skipped";
};

async function insertSearch(seed: SearchSeed): Promise<void> {
  await client.query(
    `insert into instant_searches
       (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter,
        status, summary_status, overall_stance, user_credits, credits_used, created_at,
        started_at, finished_at, deadline_at, retention_expires_at)
     values ($1, $2, $3, 'phrase', 'all', 'relevance', 'all', $4, $5, $6, 1, $7, $8, $9, $10,
             $11, $12)`,
    [
      seed.id,
      owner.customerId,
      seed.query,
      seed.status,
      seed.summaryStatus,
      seed.stance,
      seed.credits,
      seed.createdAt,
      seed.startedAt,
      seed.finishedAt,
      from(seed.createdAt, 40),
      from(seed.createdAt, 30 * 24 * 60 * 60),
    ],
  );
}

async function insertSource(
  searchId: string,
  platform: string,
  provider: string,
  state: "queued" | "searching" | "answered" | "unavailable" | "failed",
  resultCount: number,
  latencyMs: number | null,
  safeDetail: string,
): Promise<void> {
  await client.query(
    `insert into instant_search_sources
       (search_id, customer_id, platform, provider, state, result_count, latency_ms,
        credits_charged, attempted_providers, safe_detail, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      searchId,
      owner.customerId,
      platform,
      provider,
      state,
      resultCount,
      latencyMs,
      state === "answered" ? 1 : null,
      [provider],
      safeDetail,
    ],
  );
}

type ResultSeed = {
  platform: string;
  externalId: string;
  authorName: string;
  authorHandle: string;
  text: string;
  title?: string;
  publishedAt: string | null;
  thumbnailUrl?: string;
  views?: number;
  likes?: number;
  replies?: number;
  shares?: number;
  rank: number;
};

async function insertResult(searchId: string, seed: ResultSeed): Promise<string> {
  const id = randomUUID();
  const provider = seed.platform === "threads" || seed.platform === "tiktok" || seed.platform === "instagram"
    ? "scrapecreators"
    : "scrapeatlas";
  await client.query(
    `insert into instant_search_results
       (id, search_id, customer_id, platform, external_id, author_name, author_handle, url,
        text, title, published_at, thumbnail_url, views, likes, replies, shares, language,
        relevance, web_index, source_provider, routes, raw_ref, rank, collected_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'id',
             'literal_match', $17, $18, $19, $20, $21, now())`,
    [
      id,
      searchId,
      owner.customerId,
      seed.platform,
      seed.externalId,
      seed.authorName,
      seed.authorHandle,
      `https://example.invalid/${seed.platform}/${seed.externalId}`,
      seed.text,
      seed.title ?? null,
      seed.publishedAt,
      seed.thumbnailUrl ?? null,
      seed.views ?? null,
      seed.likes ?? null,
      seed.replies ?? null,
      seed.shares ?? null,
      seed.platform === "web",
      provider,
      [provider],
      `fixture:${seed.platform}:${seed.externalId}`,
      seed.rank,
    ],
  );
  return id;
}

async function insertComment(
  searchId: string,
  resultId: string,
  platform: string,
  externalId: string,
  authorName: string,
  authorHandle: string,
  text: string,
  likes: number,
  replies: number,
): Promise<void> {
  await client.query(
    `insert into instant_search_comments
       (id, search_id, customer_id, result_id, platform, external_id, author_name,
        author_handle, text, published_at, likes, replies, source_provider, raw_ref, collected_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scrapeatlas', $13, now())`,
    [
      randomUUID(),
      searchId,
      owner.customerId,
      resultId,
      platform,
      externalId,
      authorName,
      authorHandle,
      text,
      ago({ days: 4, hours: 2 }),
      likes,
      replies,
      `fixture:comment:${externalId}`,
    ],
  );
}

const completedId = randomUUID();
const runningId = randomUUID();
const coffeeId = randomUUID();
const footballId = randomUUID();

const completedCreated = ago({ hours: 2 });
await insertSearch({
  id: completedId,
  query: "barayam",
  status: "partial",
  createdAt: completedCreated,
  startedAt: from(completedCreated, 1),
  finishedAt: from(completedCreated, 31),
  stance: "campuran",
  credits: 12,
  summaryStatus: "skipped",
});

const completedSources: Array<[string, string, "answered" | "unavailable", number, number | null, string]> = [
  ["threads", "scrapecreators", "answered", 14, 3200, "ok"],
  ["tiktok", "scrapecreators", "answered", 11, 4800, "ok"],
  ["youtube", "scrapeatlas", "answered", 11, 2600, "ok"],
  ["instagram", "scrapecreators", "answered", 9, 4100, "ok"],
  ["web", "scrapeatlas", "answered", 8, 5100, "ok"],
  ["facebook", "scrapeatlas", "answered", 7, 5100, "ok"],
  ["x", "official_x", "answered", 5, 3400, "ok"],
  ["reddit", "scrapeatlas", "unavailable", 0, null, "deadline"],
];
for (const [platform, provider, state, count, latency, detail] of completedSources) {
  await insertSource(completedId, platform, provider, state, count, latency, detail);
}

const tiktokTop = await insertResult(completedId, {
  platform: "tiktok",
  externalId: "tt-barayam-1",
  authorName: "Kuliner Jakarta Selatan",
  authorHandle: "kulinerjaksel.id",
  text: "Antri 45 menit demi ayam goreng bawang putih yang lagi viral 😭 worth it ga sih? #barayam #kulinerviral #ciledug",
  publishedAt: ago({ days: 4 }),
  thumbnailUrl: "https://example.invalid/media/barayam-tiktok-1.jpg",
  views: 182000,
  likes: 9400,
  replies: 312,
  shares: 88,
  rank: 1,
});
await insertComment(completedId, tiktokTop, "tiktok", "tt-c1", "Rina", "rinaa.eats", "kriuknya beda sih, bawang putihnya wangi banget", 41, 0);
await insertComment(completedId, tiktokTop, "tiktok", "tt-c2", "Dimas", "dimasprtm", "aku ke yg Ciledug jam 3 sore masih antri panjang", 18, 0);
await insertResult(completedId, {
  platform: "tiktok",
  externalId: "tt-barayam-2",
  authorName: "Foodie Tangsel",
  authorHandle: "foodie.tangsel",
  text: "Review jujur Barayam setelah viral dari Nex Carlos: porsi gede, harga 20 ribuan. Ini skor dari aku 👇 #barayam #ayamgoreng",
  publishedAt: ago({ days: 14 }),
  thumbnailUrl: "https://example.invalid/media/barayam-tiktok-2.jpg",
  views: 96000,
  likes: 5100,
  replies: 140,
  rank: 2,
});

const threadsTop = await insertResult(completedId, {
  platform: "threads",
  externalId: "th-barayam-1",
  authorName: "Rizky Hidayat",
  authorHandle: "rizkyhdyt",
  text: "antrean barayam ciledug tadi malem sampe ke jalan raya. enak sih tapi gak sanggup tiap minggu antri gini",
  publishedAt: ago({ days: 3 }),
  likes: 1200,
  replies: 86,
  rank: 3,
});
await insertComment(completedId, threadsTop, "threads", "th-c1", "Angga", "anggaprasetya", "makanya beli lewat ojol aja, kadang lebih cepet", 33, 0);
await insertComment(completedId, threadsTop, "threads", "th-c2", "Tiara", "tiaramlnd", "cabang baru di bintaro lebih sepi kok", 12, 0);
await insertResult(completedId, {
  platform: "threads",
  externalId: "th-barayam-2",
  authorName: "Nadia Putri",
  authorHandle: "nadiaputri",
  text: "barayam buka cabang terus tiap minggu, semoga kualitasnya tetep sama kayak yg pertama di ciledug",
  publishedAt: ago({ days: 7 }),
  likes: 640,
  replies: 41,
  rank: 4,
});

await insertResult(completedId, {
  platform: "youtube",
  externalId: "yt-barayam-1",
  authorName: "Jajan Terus",
  authorHandle: "jajanterus",
  text: "BARAYAM: Ayam Goreng Bawang Putih Viral dari Ciledug, Beneran Seenak Itu?",
  title: "BARAYAM: Ayam Goreng Bawang Putih Viral dari Ciledug, Beneran Seenak Itu?",
  publishedAt: ago({ days: 21 }),
  thumbnailUrl: "https://example.invalid/media/barayam-youtube-1.jpg",
  views: 410000,
  likes: 12000,
  replies: 980,
  rank: 5,
});
await insertResult(completedId, {
  platform: "youtube",
  externalId: "yt-barayam-short-1",
  authorName: "Dwi Arsyad",
  authorHandle: "dwi.arsyad",
  text: "Barayam #shorts — kriuknya kelihatan banget",
  title: "Barayam #shorts",
  publishedAt: null,
  thumbnailUrl: "https://example.invalid/media/barayam-youtube-short.jpg",
  views: 52000,
  likes: 2100,
  replies: 74,
  rank: 12,
});

await insertResult(completedId, {
  platform: "instagram",
  externalId: "ig-barayam-1",
  authorName: "Jakarta Foodies",
  authorHandle: "jakartafoodies.id",
  text: "Akhirnya cobain Barayam! Kulitnya super crispy, sambalnya juga mantap 🔥 Wajib coba yang paket bawang putih. #barayam #kulinertangerang",
  publishedAt: ago({ days: 5 }),
  thumbnailUrl: "https://example.invalid/media/barayam-instagram-1.jpg",
  likes: 3400,
  replies: 120,
  rank: 6,
});
await insertResult(completedId, {
  platform: "facebook",
  externalId: "fb-barayam-1",
  authorName: "Info Kuliner Tangerang",
  authorHandle: "infokulinertangerang",
  text: "Ada yang tau barayam cabang Karawaci buka jam berapa? Kemarin ke sana udah habis jam 7 malam",
  publishedAt: ago({ days: 6 }),
  likes: 214,
  replies: 58,
  rank: 7,
});
await insertResult(completedId, {
  platform: "x",
  externalId: "x-barayam-1",
  authorName: "Bimo",
  authorHandle: "bimo_ad",
  text: "barayam tuh enak tapi hypenya bikin antre gak masuk akal",
  publishedAt: ago({ days: 2 }),
  views: 8100,
  likes: 312,
  replies: 24,
  rank: 8,
});
await insertResult(completedId, {
  platform: "web",
  externalId: "web-barayam-1",
  authorName: "Portal Kuliner",
  authorHandle: "portalkuliner.id",
  text: "Berawal dari satu gerai di Ciledug, Barayam ramai setelah diulas kreator kuliner dan kini membuka cabang di Jabodetabek.",
  title: "Barayam, ayam goreng bawang putih asal Ciledug yang kini buka belasan cabang",
  publishedAt: ago({ days: 7 }),
  rank: 9,
});

const runningCreated = ago({ seconds: 15 });
await insertSearch({
  id: runningId,
  query: "mandalika parfum",
  status: "running",
  createdAt: runningCreated,
  startedAt: from(runningCreated, 1),
  finishedAt: null,
  stance: null,
  credits: 6,
  summaryStatus: "pending",
});
const runningSources: Array<["answered" | "searching" | "queued" | "unavailable", string, string, number, number | null, string]> = [
  ["answered", "threads", "scrapecreators", 14, 3200, "ok"],
  ["answered", "tiktok", "scrapecreators", 11, 4800, "ok"],
  ["answered", "youtube", "scrapeatlas", 11, 2600, "ok"],
  ["answered", "facebook", "scrapeatlas", 7, 5100, "ok"],
  ["searching", "instagram", "scrapecreators", 0, null, "searching"],
  ["searching", "web", "scrapeatlas", 0, null, "searching"],
  ["queued", "x", "official_x", 0, null, "queued"],
  ["unavailable", "reddit", "scrapeatlas", 0, null, "not_found"],
];
for (const [state, platform, provider, count, latency, detail] of runningSources) {
  await insertSource(runningId, platform, provider, state, count, latency, detail);
}
await insertResult(runningId, {
  platform: "threads",
  externalId: "th-mandalika-1",
  authorName: "Wangi Lokal",
  authorHandle: "wangilokal",
  text: "mandalika parfum wanginya tahan lama, cocok buat kerja seharian",
  publishedAt: ago({ hours: 6 }),
  likes: 280,
  replies: 12,
  rank: 1,
});
await insertResult(runningId, {
  platform: "tiktok",
  externalId: "tt-mandalika-1",
  authorName: "Review Parfum",
  authorHandle: "reviewparfum.id",
  text: "Coba semprot Mandalika parfum, proyeksinya lumayan untuk harga lokal",
  publishedAt: ago({ days: 1 }),
  thumbnailUrl: "https://example.invalid/media/mandalika-tiktok-1.jpg",
  views: 47000,
  likes: 2600,
  replies: 64,
  rank: 2,
});
await insertResult(runningId, {
  platform: "youtube",
  externalId: "yt-mandalika-1",
  authorName: "Rak Perfume",
  authorHandle: "rakperfume",
  text: "Mandalika Parfum Lokal: Worth It atau Hype?",
  title: "Mandalika Parfum Lokal: Worth It atau Hype?",
  publishedAt: ago({ days: 3 }),
  thumbnailUrl: "https://example.invalid/media/mandalika-youtube-1.jpg",
  views: 21000,
  likes: 940,
  replies: 51,
  rank: 3,
});

const coffeeCreated = ago({ days: 1, hours: 1 });
await insertSearch({
  id: coffeeId,
  query: "kopi susu gula aren",
  status: "succeeded",
  createdAt: coffeeCreated,
  startedAt: from(coffeeCreated, 1),
  finishedAt: from(coffeeCreated, 24),
  stance: "positif",
  credits: 9,
  summaryStatus: "skipped",
});
for (const [platform, provider, count] of [
  ["threads", "scrapecreators", 4],
  ["tiktok", "scrapecreators", 3],
  ["instagram", "scrapecreators", 2],
  ["youtube", "scrapeatlas", 1],
  ["web", "scrapeatlas", 1],
  ["facebook", "scrapeatlas", 1],
  ["x", "official_x", 0],
  ["reddit", "scrapeatlas", 0],
] as const) {
  await insertSource(coffeeId, platform, provider, "answered", count, 2400, "ok");
}
await insertResult(coffeeId, {
  platform: "threads",
  externalId: "th-kopi-1",
  authorName: "Kopi Pagi",
  authorHandle: "kopipagi.id",
  text: "kopi susu gula aren di sudut kemang manisnya pas, gak bikin enek",
  publishedAt: ago({ days: 1 }),
  likes: 420,
  replies: 18,
  rank: 1,
});
await insertResult(coffeeId, {
  platform: "tiktok",
  externalId: "tt-kopi-1",
  authorName: "Barista Lokal",
  authorHandle: "baristalokal",
  text: "Resep kopi susu gula aren ala kafe, modalnya cuma 8 ribuan",
  publishedAt: ago({ days: 2 }),
  thumbnailUrl: "https://example.invalid/media/kopi-tiktok-1.jpg",
  views: 88000,
  likes: 4700,
  replies: 96,
  rank: 2,
});

const footballCreated = ago({ days: 3, hours: 2 });
await insertSearch({
  id: footballId,
  query: "timnas indonesia",
  status: "failed",
  createdAt: footballCreated,
  startedAt: from(footballCreated, 1),
  finishedAt: from(footballCreated, 40),
  stance: null,
  credits: 0,
  summaryStatus: "skipped",
});
for (const [platform, provider, state] of [
  ["threads", "scrapecreators", "unavailable"],
  ["tiktok", "scrapecreators", "unavailable"],
  ["x", "official_x", "failed"],
] as const) {
  await insertSource(footballId, platform, provider, state, 0, null, state === "failed" ? "timeout" : "http_5xx");
}

writeFileSync(
  out,
  JSON.stringify(
    {
      email: EMAIL,
      password: PASSWORD,
      completedSearchId: completedId,
      runningSearchId: runningId,
      olderSearchIds: [coffeeId, footballId],
    },
    null,
    2,
  ),
);

await client.end();
console.log("seeded", completedId, runningId, out);
