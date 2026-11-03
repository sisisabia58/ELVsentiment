export function normalizeVariant(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
}

export function generateCandidates(brandName: string): string[] {
  const full = normalizeVariant(brandName);
  const tokens = full.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) return [];
  const found = new Set<string>([full]);
  if (tokens.length >= 2) {
    for (let index = 0; index < tokens.length; index += 1) {
      const phrase = tokens.filter((_, tokenIndex) => tokenIndex !== index).join(" ");
      if (phrase.split(" ").length >= 2) found.add(phrase);
    }
  }
  if (tokens.length >= 4) {
    const rest = tokens.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const phrase = rest.filter((_, tokenIndex) => tokenIndex !== index).join(" ");
      if (phrase.split(" ").length >= 2) found.add(phrase);
    }
  }
  return [...found];
}

const X_QUERY_LIMIT = 512;

export type VariantListResult =
  | { ok: true; variants: string[] }
  | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string };

export function validateVariantList(variants: string[]): VariantListResult {
  const kept: string[] = [];
  for (const value of variants) {
    const normalized = normalizeVariant(value);
    if (normalized.length === 0) return { ok: false, reason: "empty", value };
    if ([...normalized].length > X_QUERY_LIMIT) return { ok: false, reason: "too_long", value };
    if (kept.includes(normalized)) return { ok: false, reason: "duplicate", value };
    kept.push(normalized);
  }
  return { ok: true, variants: kept };
}
