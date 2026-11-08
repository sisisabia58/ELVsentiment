export type KeywordIntent = "phrase" | "hashtag";

export type Keyword = { text: string; intent: KeywordIntent };

const ROUTE_COUNT: Record<string, Record<KeywordIntent, number>> = {
  threads: { phrase: 1, hashtag: 1 },
  instagram: { phrase: 1, hashtag: 1 },
  tiktok: { phrase: 2, hashtag: 1 },
};

export function canonicalKeywordText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function parseKeyword(raw: string): Keyword {
  const text = canonicalKeywordText(raw);
  const intent: KeywordIntent = text.startsWith("#") && text.length > 1 ? "hashtag" : "phrase";
  return { text, intent };
}

export function normalizeHashtag(raw: string): string {
  const normalized = raw.normalize("NFKC").toLocaleLowerCase("id-ID").replace(/^#/, "");
  return normalized.replace(/[^\p{L}\p{N}_]/gu, "");
}

export function keywordLabel(intent: KeywordIntent): "Kata kunci" | "Tagar" {
  return intent === "hashtag" ? "Tagar" : "Kata kunci";
}

export function requestCount(keywords: readonly Keyword[], sources: readonly string[]): number {
  let total = 0;
  for (const source of sources) {
    const routes = ROUTE_COUNT[source];
    if (!routes) {
      continue;
    }
    for (const keyword of keywords) {
      total += routes[keyword.intent];
    }
  }
  return total;
}
