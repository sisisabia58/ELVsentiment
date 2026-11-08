export type SourceId = "x" | "threads" | "instagram" | "tiktok";
export const ALL_SOURCES: readonly SourceId[] = ["x", "threads", "instagram", "tiktok"];
export const SOURCE_NAME: Record<SourceId, string> = {
  x: "X",
  threads: "Threads",
  instagram: "Instagram",
  tiktok: "TikTok",
};
