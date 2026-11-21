import type { SnapshotAi, SnapshotComment, SnapshotResult } from "@/monitor/search/load";
import { originalPostHref } from "@/monitor/search/post-permalink";
import { platformName } from "./platform-tile";

const STANCES = new Set(["positif", "campuran", "negatif", "netral", "faktual"]);

export function isStance(value: unknown): value is string {
  return typeof value === "string" && STANCES.has(value);
}

type SourceMetadata = Pick<SnapshotResult, "platform" | "text" | "authorName" | "authorHandle">;
type Post = SourceMetadata & Pick<SnapshotResult, "id" | "title" | "url">;
type Reply = SourceMetadata & Pick<SnapshotComment, "id" | "resultId">;

export type EvidenceSource = {
  id: string;
  href: string;
  platform: string;
  author: string;
  kind: "post" | "reply";
  texts: string[];
};

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function sourceOf(id: string, record: SourceMetadata, parent: Post, kind: EvidenceSource["kind"]): EvidenceSource {
  return {
    id,
    href: originalPostHref(parent.platform, parent.url) ?? `#hasil-${parent.id}`,
    platform: record.platform,
    author: (record.authorHandle || record.authorName || "").replace(/^@/, "").trim(),
    kind,
    texts: kind === "post" && parent.title ? [parent.text, parent.title] : [record.text],
  };
}

export function evidenceSources(
  evidenceIds: readonly string[] | undefined,
  results: Post[],
  comments: Reply[],
): Map<string, EvidenceSource> {
  const byRef = new Map<string, EvidenceSource>();
  if (!evidenceIds?.length) return byRef;
  const sample = new Set(evidenceIds);
  const parents = new Map<string, Post>();
  for (const result of results) {
    const ref = `result:${result.id}`;
    if (!sample.has(ref)) continue;
    parents.set(result.id, result);
    byRef.set(ref, sourceOf(ref, result, result, "post"));
  }
  for (const comment of comments) {
    const ref = `comment:${comment.id}`;
    const parent = parents.get(comment.resultId);
    if (sample.has(ref) && parent?.platform === comment.platform) {
      byRef.set(ref, sourceOf(ref, comment, parent, "reply"));
    }
  }
  return byRef;
}

export function sourceLabel(source: EvidenceSource): string {
  const author = source.author || (source.kind === "reply" ? "Balasan" : "Unggahan");
  return `${author} · ${platformName(source.platform)}`;
}

export function sourceLinkProps(source: EvidenceSource) {
  return source.href.startsWith("#")
    ? { href: source.href }
    : { href: source.href, target: "_blank", rel: "noopener noreferrer" };
}

export function resolveEvidence(
  ids: unknown,
  sample: Map<string, EvidenceSource>,
  platform?: string,
): EvidenceSource[] {
  if (!Array.isArray(ids)) return [];
  const sources: EvidenceSource[] = [];
  for (const id of new Set(ids)) {
    const source = typeof id === "string" ? sample.get(id) : undefined;
    if (source && (platform === undefined || source.platform === platform)) sources.push(source);
  }
  return sources;
}

export function supportedPlatforms(ai: SnapshotAi, sample: Map<string, EvidenceSource>) {
  const platforms = new Map<string, { platform: string; stance: string; summary: string; sources: EvidenceSource[] }>();
  for (const { platform, stance, summary, supporting_ids } of asRecords(ai.platformSummaries)) {
    if (typeof platform !== "string" || !isStance(stance) || typeof summary !== "string" || !summary.trim()) continue;
    const sources = resolveEvidence(supporting_ids, sample, platform);
    if (sources.length && !platforms.has(platform)) {
      platforms.set(platform, { platform, stance, summary, sources });
    }
  }
  return [...platforms.values()];
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function supportedThemes(ai: SnapshotAi, sample: Map<string, EvidenceSource>) {
  const themes = new Map<string, { title: string; stance: string; description: string; sources: EvidenceSource[] }>();
  for (const { title, stance, description, supporting_ids } of asRecords(ai.themes)) {
    if (typeof title !== "string" || !title.trim() || !isStance(stance) ||
        typeof description !== "string" || !description.trim()) continue;
    const sources = resolveEvidence(supporting_ids, sample);
    const key = normalized(title);
    if (sources.length && !themes.has(key)) themes.set(key, { title, stance, description, sources });
  }
  return [...themes.values()];
}

export const QUOTE_LABELS = [
  ["pujian", "Pujian"],
  ["keluhan", "Keluhan"],
  ["pengamatan", "Pengamatan"],
  ["pertanyaan", "Pertanyaan"],
] as const;

export function supportedQuotes(ai: SnapshotAi, sample: Map<string, EvidenceSource>) {
  const quotes = new Map<string, { type: string; text: string; source: EvidenceSource }>();
  for (const { type, text, ref_id } of asRecords(ai.quotes)) {
    const source = typeof ref_id === "string" ? sample.get(ref_id) : undefined;
    if (typeof type !== "string" || !QUOTE_LABELS.some(([key]) => key === type) ||
        typeof text !== "string" || !text.trim() || text.length > 240 ||
        !source || !source.texts.some((value) => value.includes(text))) continue;
    const key = normalized(text);
    if (!quotes.has(key)) quotes.set(key, { type, text, source });
  }
  return [...quotes.values()];
}
