// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy";

function request(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:43123${path}`);
}

async function status(path: string): Promise<number> {
  return (await proxy(request(path))).status;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("flag-off Cari routes answer a real 404", () => {
  it("returns 404 for the search pages before any Suspense shell streams", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "0");
    expect(await status("/cari")).toBe(404);
    expect(await status("/cari/riwayat")).toBe(404);
    expect(await status("/cari/33333333-3333-4333-8333-333333333333")).toBe(404);
  });

  it("returns 404 for provider settings while the feature is off", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "0");
    expect(await status("/pengaturan/provider")).toBe(404);
  });

  it("leaves unrelated paths and the JSON API alone", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "0");
    expect(await status("/cari-lain")).toBe(200);
    expect(await status("/api/cari/33333333-3333-4333-8333-333333333333")).toBe(200);
  });

  it("serves the pages normally when the flag is on", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "1");
    expect(await status("/cari")).toBe(200);
    expect(await status("/cari/riwayat")).toBe(200);
    expect(await status("/pengaturan/provider")).toBe(200);
  });

  it("matches the routes that carry the gate", () => {
    expect(config.matcher).toContain("/cari");
    expect(config.matcher).toContain("/cari/:path*");
    expect(config.matcher).toContain("/pengaturan/provider");
  });
});
