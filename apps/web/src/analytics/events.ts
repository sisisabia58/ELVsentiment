export const EVENT_NAMES = [
  "project_created",
  "keyword_added",
  "keyword_removed",
  "source_connection_outcome",
  "attention_eligible",
  "attention_indicator_surfaced",
  "attention_marked_seen",
  "attention_state_update_failed",
  "attention_deduped",
  "mention_collected",
  "mention_deduplicated",
  "scoring_completed",
  "scoring_failed",
  "relevance_excluded",
  "routed_not_sure",
  "dashboard_viewed",
  "source_link_opened",
  "review_confirmed",
  "review_corrected",
  "needs_attention_viewed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const FORBIDDEN_KEYS = new Set([
  "excerpt",
  "text",
  "password",
  "token",
  "authorization",
  "credential",
  "apiKey",
  "bearer",
]);

export function buildEvent(
  name: EventName,
  properties: Record<string, string | number | boolean>,
): { name: EventName; properties: Record<string, string | number | boolean> } {
  for (const key of Object.keys(properties)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error("forbidden_property");
  }
  return { name, properties };
}
