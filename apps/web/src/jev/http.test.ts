import { afterEach, describe, expect, it, vi } from "vitest";
import { postSystemOne } from "./http";

describe("postSystemOne", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects with network true when fetch rejects with TypeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await expect(postSystemOne("https://jev.invalid/systemone", { model: "jev-1.14.0" }, "test-key")).rejects.toEqual({
      network: true,
    });
  });

  it("rejects with timeout true when the abort signal fires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          }
        });
      }),
    );

    await expect(
      postSystemOne("https://jev.invalid/systemone", { model: "jev-1.14.0" }, "test-key", 1),
    ).rejects.toEqual({ timeout: true });
  });
});
