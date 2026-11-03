import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs, isRetryable, postWithRetry, redactAuthorization } from "./retry";

describe("isRetryable", () => {
  it("is true for timeout, 429, and 5xx only", () => {
    expect(isRetryable({ timeout: true })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 599 })).toBe(true);
    expect(isRetryable({ network: true })).toBe(false);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("uses exponential base with cap and jitter", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(200);
    expect(backoffDelayMs(0, () => 0.5)).toBe(250);
    expect(backoffDelayMs(1, () => 0)).toBe(400);
    expect(backoffDelayMs(10, () => 0)).toBe(5000);
  });
});

describe("redactAuthorization", () => {
  it("strips bearer tokens and api keys case-insensitively", () => {
    const message = "authorization: Bearer super-secret-jev and Authorization: Bearer other";
    expect(redactAuthorization(message, "super-secret-jev")).not.toContain("super-secret-jev");
    expect(redactAuthorization(message, "super-secret-jev")).not.toContain("Bearer super-secret-jev");
    expect(redactAuthorization(message, "super-secret-jev")).toContain("[redacted]");
  });
});

describe("postWithRetry", () => {
  it.each([
    { label: "429", error: { status: 429 } },
    { label: "503", error: { status: 503 } },
    { label: "timeout", error: { timeout: true } },
  ])("succeeds on the second call after $label", async ({ error }) => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn(async () => {});
    const random = () => 0;

    const result = await postWithRetry(post, { model: "jev" }, "key", { sleep, random });

    expect(result).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(backoffDelayMs(0, random));
  });

  it.each([400, 401, 403, 404])("does not retry on status %i", async (status) => {
    const post = vi.fn().mockRejectedValue({ status });
    const sleep = vi.fn(async () => {});

    await expect(postWithRetry(post, {}, "key", { sleep })).rejects.toEqual({ status });
    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after four retryable failures", async () => {
    const post = vi.fn().mockRejectedValue({ status: 503 });
    const sleep = vi.fn(async () => {});

    await expect(postWithRetry(post, {}, "key", { sleep, random: () => 0 })).rejects.toEqual({ status: 503 });
    expect(post).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("logs redacted authorization errors", async () => {
    const post = vi.fn().mockRejectedValue(new Error("Authorization: Bearer super-secret-jev"));
    const log = vi.fn();
    const sleep = vi.fn(async () => {});

    await expect(
      postWithRetry(post, {}, "super-secret-jev", { log, sleep, random: () => 0 }),
    ).rejects.toThrow();
    expect(log).toHaveBeenCalled();
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).not.toContain("super-secret-jev");
    expect(logged).not.toContain("Bearer super-secret-jev");
  });
});
