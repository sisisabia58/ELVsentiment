import { describe, expect, it } from "vitest";
import {
  ONBOARDING_DRAFT_MAX_BYTES,
  allowedOnboardingStep,
  bindOnboardingDraft,
  listedKeywords,
  onboardingLangkahRedirect,
  parseOnboardingDraft,
  parseOnboardingStep,
  resolveOnboardingState,
  workingSources,
  type OnboardingDraft,
} from "./onboarding-draft";

const schedule = { mode: "off" as const, intervalHours: 6 };
const customerA = "11111111-1111-4111-8111-111111111111";
const customerB = "22222222-2222-4222-8222-222222222222";

function draft(overrides: Partial<OnboardingDraft> = {}): OnboardingDraft {
  return {
    customerId: customerA,
    projectId: null,
    step: 2,
    brand: "kopi susu",
    keywords: ["kopi susu", "susu aren"],
    sources: ["x", "threads"],
    schedule,
    ...overrides,
  };
}

describe("onboarding draft", () => {
  it("keeps a custom keyword in the list beside generated candidates", () => {
    expect(listedKeywords(["qa test brand", "test brand"], ["qa test brand", "gembus spesial"])).toEqual([
      "qa test brand",
      "test brand",
      "gembus spesial",
    ]);
  });

  it("drops a source that has no server credential so it cannot be selected as working", () => {
    expect(workingSources(["x", "threads"], { x: true, threads: false })).toEqual(["x"]);
    expect(workingSources(["x", "threads"], { x: false, threads: false })).toEqual([]);
    expect(workingSources(["threads"], { x: true, threads: true })).toEqual(["threads"]);
    expect(
      workingSources(["x", "threads", "instagram", "tiktok"], {
        x: false,
        threads: true,
        instagram: true,
        tiktok: true,
      }),
    ).toEqual(["threads", "instagram", "tiktok"]);
    const parsed = parseOnboardingDraft(
      JSON.stringify(draft({ sources: ["x", "threads", "instagram", "tiktok"] })),
    );
    expect(parsed?.sources).toEqual(["x", "threads", "instagram", "tiktok"]);
  });

  it("restores the URL step and the saved field values together", () => {
    const saved = draft();
    const encoded = encodeURIComponent(JSON.stringify(saved));
    expect(parseOnboardingDraft(encoded)).toEqual(saved);
    expect(parseOnboardingDraft(JSON.stringify(saved))).toEqual(saved);
    expect(parseOnboardingStep("4")).toBe(4);
    expect(parseOnboardingStep("0")).toBeNull();
    expect(parseOnboardingStep("abc")).toBeNull();

    const restored = resolveOnboardingState({
      fresh: false,
      langkah: "4",
      draft: saved,
      customerId: customerA,
      existing: null,
      credentials: { x: true, threads: false },
    });
    expect(restored.step).toBe(4);
    expect(restored.brand).toBe("kopi susu");
    expect(restored.keywords).toEqual(["kopi susu", "susu aren"]);
    expect(restored.sources).toEqual(["x"]);
    expect(restored.schedule).toEqual(schedule);
  });

  it("keeps a percent sign in the brand instead of dropping the draft", () => {
    const saved = draft({ brand: "100%", keywords: ["100%"] });
    expect(parseOnboardingDraft(JSON.stringify(saved))?.brand).toBe("100%");
    expect(parseOnboardingDraft(encodeURIComponent(JSON.stringify(saved)))?.keywords).toEqual(["100%"]);
  });

  it("ignores a draft from another project and a fresh start", () => {
    const saved = draft({ projectId: "other", step: 3, brand: "lama", keywords: ["lama"], sources: ["x"] });
    const existing = {
      projectId: "mine",
      brandName: "baru",
      keywords: ["baru"],
      sources: ["threads"] as ("x" | "threads")[],
      schedule,
    };
    expect(
      resolveOnboardingState({
        fresh: false,
        langkah: null,
        draft: saved,
        customerId: customerA,
        existing,
        credentials: { x: true, threads: true },
      }),
    ).toMatchObject({ step: 1, brand: "baru", keywords: ["baru"], sources: ["threads"] });
    expect(
      resolveOnboardingState({
        fresh: true,
        langkah: "2",
        draft: saved,
        customerId: customerA,
        existing,
        credentials: { x: false, threads: true },
      }),
    ).toMatchObject({ step: 1, brand: "", keywords: [], sources: ["threads"] });
  });

  it("hides a draft with no project from a different signed-in customer", () => {
    const saved = draft({ projectId: null, brand: "rahasia merek", keywords: ["rahasia"] });
    expect(
      resolveOnboardingState({
        fresh: false,
        langkah: null,
        draft: saved,
        customerId: customerB,
        existing: null,
        credentials: { x: true, threads: true },
      }),
    ).toMatchObject({ step: 1, brand: "", keywords: [] });
    expect(
      resolveOnboardingState({
        fresh: false,
        langkah: "3",
        draft: saved,
        customerId: customerA,
        existing: null,
        credentials: { x: true, threads: false },
      }),
    ).toMatchObject({ step: 3, brand: "rahasia merek", keywords: ["rahasia"], sources: ["x"] });
  });

  it("drops a draft that is not bound to a customer", () => {
    const raw = JSON.stringify({ ...draft(), customerId: undefined });
    expect(parseOnboardingDraft(raw)).toBeNull();
  });

  it("binds the draft to the session customer and refuses an oversized or forged id", () => {
    const fields = {
      projectId: null,
      step: 2,
      brand: "kopi susu",
      keywords: ["kopi susu"],
      sources: ["x"] as ("x" | "threads")[],
      schedule,
    };
    const bound = bindOnboardingDraft(customerA, { ...fields, customerId: customerB } as typeof fields);
    expect(bound?.customerId).toBe(customerA);
    expect(bindOnboardingDraft("", fields)).toBeNull();
    expect(bindOnboardingDraft(customerA, { ...fields, brand: "m".repeat(161) })).toBeNull();
    expect(bindOnboardingDraft(customerA, { ...fields, keywords: Array.from({ length: 25 }, (_, index) => `kata ${index}`) })).toBeNull();
    const bulky = bindOnboardingDraft(customerA, {
      ...fields,
      keywords: Array.from({ length: 24 }, () => "k".repeat(160)),
    });
    expect(bulky).toBeNull();
    expect(ONBOARDING_DRAFT_MAX_BYTES).toBeLessThan(4096);
  });

  it("stops langkah=3 on the keyword step when step 2 is not complete", () => {
    const saved = draft({ step: 3, brand: "kopi susu", keywords: [], sources: ["x"] });
    const restored = resolveOnboardingState({
      fresh: false,
      langkah: "3",
      draft: saved,
      customerId: customerA,
      existing: null,
      credentials: { x: true, threads: true },
    });
    expect(allowedOnboardingStep({
      brand: restored.brand,
      keywords: restored.keywords,
      sources: restored.sources,
      credentials: { x: true, threads: true },
    })).toBe(2);
    expect(restored.step).toBe(2);
    expect(onboardingLangkahRedirect({ langkah: "3", fresh: false, resolvedStep: restored.step })).toBe(
      "/onboarding?langkah=2",
    );
    expect(
      onboardingLangkahRedirect({ langkah: "2", fresh: false, resolvedStep: 2 }),
    ).toBeNull();
    expect(
      resolveOnboardingState({
        fresh: true,
        langkah: "3",
        draft: null,
        customerId: customerA,
        existing: null,
        credentials: { x: true, threads: false },
      }).step,
    ).toBe(1);
  });
});
