import { describe, expect, it, vi } from "vitest";
import { buildSystemOneBody, scoreWithFallback, shouldFallback, TYPESAFE_MODEL, OPENROUTER_MODEL } from "./client";

const answers = {
  relevant: { type: "noul", noul: 0.93 },
  sentiment: { type: "choice", choice: "negative", confidence: 0.88 },
  topic_harga: { type: "noul", noul: 0.8 },
};

describe("buildSystemOneBody", () => {
  it("puts relevance, sentiment, and topics in one body and does not ask for a box", () => {
    const body = buildSystemOneBody({
      model: TYPESAFE_MODEL,
      brandName: "ayam geprek pak gembus",
      text: "geprek gembus mahal",
      topics: [{ id: "harga", instructions: "The post is about price." }],
    });
    expect(body.model).toBe("jev-1.14.0");
    expect(body.questions.relevant).toMatchObject({ type: "noul" });
    expect(body.questions.sentiment).toMatchObject({ type: "choice" });
    expect(body.questions.topic_harga).toMatchObject({ type: "noul" });
    expect(JSON.stringify(body)).not.toContain('"box"');
  });
});

describe("scoreWithFallback", () => {
  it("calls the primary once when it succeeds", async () => {
    const primary = vi.fn(async () => ({ model: "jev-1.14.0", answers }));
    const fallback = vi.fn();
    const body = buildSystemOneBody({
      model: TYPESAFE_MODEL,
      brandName: "ayam geprek pak gembus",
      text: "geprek gembus mahal",
      topics: [{ id: "harga", instructions: "The post is about price." }],
    });
    const scored = await scoreWithFallback(body, { primary, fallback }, true);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(scored.provider).toBe("typesafe");
    expect(scored.judgment.sentiment).toBe("negative");
    expect(scored.judgment.topicNouls).toEqual([{ id: "harga", noul: 0.8 }]);
  });

  it("falls back on a 503 and refuses a 400", async () => {
    const body = buildSystemOneBody({
      model: TYPESAFE_MODEL,
      brandName: "merek",
      text: "teks",
      topics: [],
    });
    const fallback = vi.fn(async () => ({ model: "typesafe/jev-1.14", answers }));
    const scored = await scoreWithFallback(
      body,
      { primary: async () => Promise.reject({ status: 503 }), fallback },
      true,
    );
    expect(scored.provider).toBe("openrouter");
    expect(scored.model).toBe(OPENROUTER_MODEL);
    await expect(
      scoreWithFallback(body, { primary: async () => Promise.reject({ status: 400 }), fallback }, true),
    ).rejects.toEqual({ status: 400 });
  });

  it("falls back when the primary throws a dropped connection", async () => {
    const body = buildSystemOneBody({
      model: TYPESAFE_MODEL,
      brandName: "merek",
      text: "teks",
      topics: [],
    });
    const fallback = vi.fn(async () => ({ model: "typesafe/jev-1.14", answers }));
    const scored = await scoreWithFallback(
      body,
      { primary: async () => Promise.reject({ network: true }), fallback },
      true,
    );
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(scored.provider).toBe("openrouter");
    expect(scored.model).toBe(OPENROUTER_MODEL);
  });

  it("does not call OpenRouter when the fallback flag is off", async () => {
    const fallback = vi.fn();
    const body = buildSystemOneBody({ model: TYPESAFE_MODEL, brandName: "merek", text: "teks", topics: [] });
    await expect(
      scoreWithFallback(body, { primary: async () => Promise.reject({ status: 503 }), fallback }, false),
    ).rejects.toEqual({ status: 503 });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not call fallback on 429 when fallback is disabled", async () => {
    const fallback = vi.fn();
    const body = buildSystemOneBody({ model: TYPESAFE_MODEL, brandName: "merek", text: "teks", topics: [] });
    await expect(
      scoreWithFallback(body, { primary: async () => Promise.reject({ status: 429 }), fallback }, false),
    ).rejects.toEqual({ status: 429 });
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("shouldFallback", () => {
  it("is true for a dropped connection and false for 401", () => {
    expect(shouldFallback({ network: true })).toBe(true);
    expect(shouldFallback({ status: 401 })).toBe(false);
  });
});
