import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SEARCH_RELEVANCE_VERSION = 1;
type AcceptedRelevance = "literal_match" | "all_words_match";

const configDir = process.env.CONFIG_DIR?.trim();
const rules = JSON.parse(readFileSync(
  configDir
    ? path.join(configDir, "cari-relevance.json")
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../config/cari-relevance.json"),
  "utf8",
)) as { entity_descriptors: Record<string, string[]> };

const entityDescriptors = new Map(Object.entries(rules.entity_descriptors));
const word = "[\\p{L}\\p{N}_]";

function normalize(value: string): string {
  // Legacy checks use ECMAScript lowercasing and handle sharp S and Greek sigma
  // equivalence. Full Python case folding, including iota subscripts, needs a rerun.
  return value.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ").trim().replace(/\s+/gu, " ");
}

function whole(term: string): RegExp {
  const escaped = term.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<!" + word + ")" + escaped + "(?!" + word + ")", "u");
}

function compact(value: string, foldAccents = false): string {
  return (foldAccents ? value.normalize("NFKD").replace(/\p{M}/gu, "") : value).replace(/[^\p{L}\p{N}_]/gu, "");
}

function hasAnchor(words: string[], body: string): boolean {
  if (words.length !== 2) return false;
  const [left, right] = words;
  return [[left, right], [right, left]].some(([anchor, descriptor]) => (
    entityDescriptors.get(anchor)?.includes(descriptor) && whole(anchor).test(body)
  ));
}

// Legacy rows retain captions/titles but not provider hashtag metadata. Recheck
// the stored evidence without trusting the old label or guessing missing tags.
export function savedEvidenceRelevance(
  post: { text: string; title: string | null },
  query: string,
  intent: string,
): AcceptedRelevance | null {
  const candidates = [normalize(post.text), normalize(post.title ?? "")];
  const tags = candidates.flatMap((candidate) => [...candidate.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((tag) => tag[1]));
  const keyword = normalize(query);
  const term = intent === "hashtag" ? compact(keyword) : keyword.replace(/^#/, "");
  if (!term) return null;
  const folded = compact(term, true);
  if (candidates.some((candidate) => whole(term).test(candidate))
      || (folded && (intent === "hashtag" || term.includes(" ") || [...folded].length >= 2)
        && tags.some((tag) => compact(tag, true) === folded))) return "literal_match";
  const body = candidates.join(" ").trim();
  const words = keyword.split(" ");
  if (words.every((token) => whole(token.replace(/^#/, "")).test(body))
      || (intent === "phrase" && hasAnchor(words, body))) return "all_words_match";
  return null;
}
