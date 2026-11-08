export type TextMatch = "literal_match" | "no_literal_match" | "unknown_text" | "legacy_unassessed";

export type TextMatchCounts = { candidates: number; literal: number; unknown: number };

export const TEXT_MATCH_LABEL: Record<TextMatch, string> = {
  literal_match: "Cocok teks",
  no_literal_match: "Tidak cocok teks",
  unknown_text: "Belum pasti",
  legacy_unassessed: "Belum dinilai (data lama)",
};

export function textMatchOf(statuses: readonly string[]): TextMatch {
  if (statuses.includes("literal_match")) return "literal_match";
  if (statuses.length === 0) return "legacy_unassessed";
  if (statuses.includes("unknown_text")) return "unknown_text";
  return "no_literal_match";
}

export function textMatchCounts(mentions: readonly { textMatch: TextMatch }[]): TextMatchCounts {
  let literal = 0;
  let unknown = 0;
  for (const mention of mentions) {
    if (mention.textMatch === "literal_match") literal += 1;
    else if (mention.textMatch === "unknown_text" || mention.textMatch === "legacy_unassessed") unknown += 1;
  }
  return { candidates: mentions.length, literal, unknown };
}
