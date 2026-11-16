// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cariIdGate, config, providerAdminGate, proxy } from "./proxy";

function request(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:43123${path}`);
}

function signedIn(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:43123${path}`, {
    headers: { cookie: "sm_session=synthetic-session-token" },
  });
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

describe("provider settings admin gate", () => {
  it("returns 404 to a signed-in non-admin", async () => {
    const response = await providerAdminGate(signedIn("/pengaturan/provider"), async () => false);
    expect(response?.status).toBe(404);
  });

  it("lets a platform admin through", async () => {
    const response = await providerAdminGate(signedIn("/pengaturan/provider"), async () => true);
    expect(response).toBeNull();
  });

  it("leaves an unusable session to the page's normal sign-in redirect", async () => {
    const response = await providerAdminGate(signedIn("/pengaturan/provider"), async () => null);
    expect(response).toBeNull();
  });

  it("ignores other paths and signed-out callers", async () => {
    expect(
      await providerAdminGate(request("/cari"), async () => false),
    ).toBeNull();
    expect(
      await providerAdminGate(request("/pengaturan/provider"), async () => false),
    ).toBeNull();
  });
});

describe("cari detail id gate", () => {
  const OWN = "33333333-3333-4333-8333-333333333333";

  it("returns a real 404 for a malformed id before any lookup", async () => {
    let called = false;
    const response = await cariIdGate(request("/cari/not-a-uuid"), async () => {
      called = true;
      return true;
    });
    expect(response?.status).toBe(404);
    expect(called).toBe(false);
  });

  it("returns a real 404 for a uuid that is not this session's search", async () => {
    const response = await cariIdGate(signedIn(`/cari/${OWN}`), async () => false);
    expect(response?.status).toBe(404);
  });

  it("lets the owner's uuid through", async () => {
    const response = await cariIdGate(signedIn(`/cari/${OWN}`), async () => true);
    expect(response).toBeNull();
  });

  it("does not gate the history page, multi-segment paths, or signed-out callers", async () => {
    expect(await cariIdGate(signedIn("/cari/riwayat"), async () => false)).toBeNull();
    expect(await cariIdGate(signedIn(`/cari/${OWN}/x`), async () => false)).toBeNull();
    expect(await cariIdGate(request(`/cari/${OWN}`), async () => false)).toBeNull();
  });

  it("falls through when a lookup cannot decide", async () => {
    expect(await cariIdGate(signedIn(`/cari/${OWN}`), async () => null)).toBeNull();
  });

  it("is wired into the proxy for /cari/<uuid>", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "1");
    expect(await status(`/cari/${OWN}`)).not.toBe(404);
    expect(config.matcher).toContain("/cari/:path*");
  });
});
