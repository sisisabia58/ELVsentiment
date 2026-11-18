import type { ScheduleChoice } from "@/monitor/schedule-choice";
import type { SourceId } from "@/monitor/sources";

const PROJECT_SOURCES: readonly SourceId[] = ["threads", "tiktok", "instagram", "x"];

export function buildOnboardingFields(
  search: { query: string; platforms: readonly string[] },
  platforms: readonly string[],
): { brand: string; keywords: string[]; sources: SourceId[]; schedule: ScheduleChoice } {
  const allowed = new Set(platforms);
  const brand = search.query.trim();
  const sources = search.platforms.filter(
    (platform): platform is SourceId =>
      (PROJECT_SOURCES as readonly string[]).includes(platform) && allowed.has(platform),
  );
  return {
    brand,
    keywords: brand ? [brand] : [],
    sources,
    schedule: { mode: "off", intervalHours: 6 },
  };
}
