import { ALL_SOURCES, SOURCE_NAME, type SourceId } from "./policy";
import type { ScheduleChoice } from "./schedule-choice";

export { ALL_SOURCES, SOURCE_NAME, type SourceId };

export const ONBOARDING_DRAFT_COOKIE = "onboarding_draft";
export const ONBOARDING_DRAFT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
// Stay under the 4KB cookie ceiling after percent-encoding, including the name.
export const ONBOARDING_DRAFT_MAX_BYTES = 3500;

const MAX_BRAND_LENGTH = 160;
const MAX_KEYWORDS = 24;
const MAX_KEYWORD_LENGTH = 160;
const MAX_ID_LENGTH = 64;

export type OnboardingDraft = {
  customerId: string;
  projectId: string | null;
  step: number;
  brand: string;
  keywords: string[];
  sources: SourceId[];
  schedule: ScheduleChoice;
};

// Fields the browser may send. The customer id is never one of them.
export type OnboardingDraftFields = {
  projectId: string | null;
  step: number;
  brand: string;
  keywords: string[];
  sources: SourceId[];
  schedule: ScheduleChoice;
};

export type SourceCredentials = {
  x: boolean;
  threads: boolean;
  instagram?: boolean;
  tiktok?: boolean;
};

export function asSources(value: unknown): SourceId[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is SourceId =>
      item === "x" || item === "threads" || item === "instagram" || item === "tiktok",
  );
}

export function listedKeywords(candidates: readonly string[], selected: readonly string[]): string[] {
  const seen = new Set<string>();
  const listed: string[] = [];
  for (const value of [...candidates, ...selected]) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    listed.push(value);
  }
  return listed;
}

export function workingSources(
  requested: readonly SourceId[],
  credentials: SourceCredentials,
): SourceId[] {
  return requested.filter((source) => Boolean(credentials[source]));
}

// The furthest step the saved fields can open. A later langkah is out of order.
export function allowedOnboardingStep(input: {
  brand: string;
  keywords: readonly string[];
  sources: readonly SourceId[];
  credentials: SourceCredentials;
}): number {
  if (input.brand.trim().length === 0) return 1;
  if (input.keywords.length === 0) return 2;
  const available = ALL_SOURCES.filter((source) => Boolean(input.credentials[source]));
  const selected = input.sources.filter((source) => available.includes(source));
  if (available.length > 0 && selected.length === 0) return 3;
  return 5;
}

export function onboardingLangkahRedirect(input: {
  langkah: string | null | undefined;
  fresh: boolean;
  resolvedStep: number;
}): string | null {
  const requested = parseOnboardingStep(input.langkah);
  if (requested == null || requested <= input.resolvedStep) return null;
  const params = new URLSearchParams();
  if (input.fresh) params.set("baru", "1");
  params.set("langkah", String(input.resolvedStep));
  return `/onboarding?${params.toString()}`;
}

export function parseOnboardingStep(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const step = Number(value);
  if (!Number.isInteger(step) || step < 1 || step > 5) return null;
  return step;
}

function parseSchedule(value: unknown): ScheduleChoice | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { mode?: unknown; intervalHours?: unknown; hours?: unknown; minute?: unknown };
  if (record.mode === "off") {
    const intervalHours = typeof record.intervalHours === "number" ? record.intervalHours : 6;
    return { mode: "off", intervalHours };
  }
  if (record.mode === "daily" && typeof record.minute === "number") return { mode: "daily", minute: record.minute };
  if (record.mode === "interval" && (record.hours === 6 || record.hours === 12 || record.hours === 24)) {
    return { mode: "interval", hours: record.hours };
  }
  return null;
}

function draftJson(raw: string): unknown | null {
  const attempts = [raw];
  if (raw.includes("%")) {
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw) attempts.push(decoded);
    } catch {
      // A brand like "100%" is valid JSON. Decoding is only for a still-encoded cookie.
    }
  }
  for (const text of attempts) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

export function parseOnboardingDraft(raw: string | null | undefined): OnboardingDraft | null {
  if (!raw) return null;
  const value = draftJson(raw);
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<OnboardingDraft>;
  try {
    const step = parseOnboardingStep(record.step == null ? null : String(record.step));
    if (!step || typeof record.brand !== "string" || !Array.isArray(record.keywords)) return null;
    if (typeof record.customerId !== "string" || record.customerId.length === 0 || record.customerId.length > MAX_ID_LENGTH) {
      return null;
    }
    if (!record.keywords.every((item) => typeof item === "string")) return null;
    const sources = asSources(record.sources);
    const schedule = parseSchedule(record.schedule);
    if (!schedule) return null;
    const projectId = typeof record.projectId === "string" ? record.projectId : null;
    if (projectId !== null && (projectId.length === 0 || projectId.length > MAX_ID_LENGTH)) return null;
    return {
      customerId: record.customerId,
      projectId,
      step,
      brand: record.brand,
      keywords: record.keywords,
      sources,
      schedule,
    };
  } catch {
    return null;
  }
}

// Bind the draft to the session customer. A customer id on `fields` is ignored,
// and the returned id must not be used as the tenant for a write.
export function bindOnboardingDraft(customerId: string, fields: OnboardingDraftFields): OnboardingDraft | null {
  if (typeof customerId !== "string" || customerId.length === 0 || customerId.length > MAX_ID_LENGTH) return null;
  // The session id is applied last so a forged customerId on fields cannot win.
  const draft = parseOnboardingDraft(JSON.stringify({ ...fields, customerId }));
  if (!draft || draft.customerId !== customerId) return null;
  if (draft.brand.length > MAX_BRAND_LENGTH) return null;
  if (draft.keywords.length > MAX_KEYWORDS) return null;
  if (draft.keywords.some((keyword) => keyword.length > MAX_KEYWORD_LENGTH)) return null;
  if (encodeURIComponent(JSON.stringify(draft)).length > ONBOARDING_DRAFT_MAX_BYTES) return null;
  return draft;
}

export function resolveOnboardingState(input: {
  fresh: boolean;
  langkah: string | null | undefined;
  draft: OnboardingDraft | null;
  customerId: string;
  existing: {
    projectId: string;
    brandName: string;
    keywords: string[];
    sources: SourceId[];
    schedule: ScheduleChoice;
  } | null;
  credentials: SourceCredentials;
}): {
  step: number;
  brand: string;
  keywords: string[];
  sources: SourceId[];
  schedule: ScheduleChoice;
} {
  const blank = {
    step: 1,
    brand: "",
    keywords: [] as string[],
    sources: workingSources(ALL_SOURCES, input.credentials),
    schedule: { mode: "off" as const, intervalHours: 6 },
  };
  if (input.fresh) {
    const step = Math.min(parseOnboardingStep(input.langkah) ?? 1, allowedOnboardingStep({ ...blank, credentials: input.credentials }));
    return { ...blank, step };
  }
  const draftMatches =
    input.draft !== null &&
    input.draft.customerId === input.customerId &&
    (input.existing ? input.draft.projectId === input.existing.projectId : input.draft.projectId === null);
  const base =
    draftMatches && input.draft
      ? {
          step: input.draft.step,
          brand: input.draft.brand,
          keywords: input.draft.keywords,
          sources: input.draft.sources,
          schedule: input.draft.schedule,
        }
      : input.existing
        ? {
            step: 1,
            brand: input.existing.brandName,
            keywords: input.existing.keywords.length > 0 ? input.existing.keywords : [input.existing.brandName],
            sources: input.existing.sources,
            schedule: input.existing.schedule,
          }
        : blank;
  const next = {
    step: parseOnboardingStep(input.langkah) ?? base.step,
    brand: base.brand,
    keywords: base.keywords,
    sources: workingSources(base.sources, input.credentials),
    schedule: base.schedule,
  };
  const allowed = allowedOnboardingStep({ ...next, credentials: input.credentials });
  return { ...next, step: Math.min(next.step, allowed) };
}
