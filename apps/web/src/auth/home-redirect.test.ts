import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { homeDestination, SESSION_COOKIE } from "./home-redirect";
import { config, proxy, redirectHome, redirectSignedOut } from "../proxy";

vi.mock("@/db/pg", () => ({
  withClient: vi.fn(async () => {
    throw new Error("connect ECONNREFUSED");
  }),
}));

describe("home destination", () => {
  it("sends a missing cookie to /masuk without a database lookup", async () => {
    const lookup = vi.fn(async () => "customer");
    expect(await homeDestination(undefined, lookup)).toBe("/masuk");
    expect(await homeDestination("", lookup)).toBe("/masuk");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("sends a session the database recognizes to /dasbor", async () => {
    const lookup = vi.fn(async () => "customer");
    expect(await homeDestination("token", lookup)).toBe("/dasbor");
    expect(lookup).toHaveBeenCalledWith("token");
  });

  it("sends an unrecognized session cookie to /masuk", async () => {
    expect(await homeDestination("stale", async () => null)).toBe("/masuk");
  });
});

describe("home proxy", () => {
  it("redirects / before rendering, from the cookie and the database check", async () => {
    const signedOut = new NextRequest("http://127.0.0.1:43123/");
    const missing = await redirectHome(signedOut, async () => {
      throw new Error("lookup should not run");
    });
    expect(missing.status).toBe(307);
    expect(new URL(missing.headers.get("location") ?? "").pathname).toBe("/masuk");
    expect(await missing.text()).not.toContain("<html");

    const signedIn = new NextRequest("http://127.0.0.1:43123/", {
      headers: { cookie: `${SESSION_COOKIE}=token` },
    });
    const found = await redirectHome(signedIn, async () => "customer");
    expect(found.status).toBe(307);
    expect(new URL(found.headers.get("location") ?? "").pathname).toBe("/dasbor");

    const stale = await redirectHome(signedIn, async () => null);
    expect(new URL(stale.headers.get("location") ?? "").pathname).toBe("/masuk");
  });

  it("fails safe to /masuk when the database lookup throws", async () => {
    const request = new NextRequest("http://127.0.0.1:43123/", {
      headers: { cookie: `${SESSION_COOKIE}=token` },
    });
    const response = await proxy(request);
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/masuk");
    expect(await response.text()).not.toContain("<html");
  });

  it("does not treat Next.js's second argument as the session lookup", async () => {
    const request = new NextRequest("http://127.0.0.1:43123/", {
      headers: { cookie: `${SESSION_COOKIE}=token` },
    });
    const response = await (proxy as (request: NextRequest, event?: unknown) => Promise<Response>)(request, {
      type: "NextFetchEvent",
    });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/masuk");
  });

  it("does not intercept static files", async () => {
    const matchers = Array.isArray(config.matcher) ? config.matcher : [config.matcher];
    expect(matchers).toContain("/");
    expect(matchers.some((entry) => String(entry).includes("dasbor"))).toBe(true);
    expect(matchers.join(" ")).not.toContain("_next");
    const css = new NextRequest("http://127.0.0.1:43123/_next/static/chunks/app.css");
    const response = await redirectHome(css, async () => {
      throw new Error("lookup should not run");
    });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects a signed-out app route to /masuk before any page HTML", async () => {
    const signedOut = new NextRequest("http://127.0.0.1:43123/dasbor?proyek=abc");
    const missing = await redirectSignedOut(signedOut, async () => {
      throw new Error("lookup should not run");
    });
    expect(missing.status).toBe(307);
    expect(new URL(missing.headers.get("location") ?? "").pathname).toBe("/masuk");
    expect(new URL(missing.headers.get("location") ?? "").search).toBe("");
    expect(await missing.text()).not.toContain("<html");

    const stale = new NextRequest("http://127.0.0.1:43123/proyek/abc/pengaturan", {
      headers: { cookie: `${SESSION_COOKIE}=stale` },
    });
    const rejected = await redirectSignedOut(stale, async () => null);
    expect(new URL(rejected.headers.get("location") ?? "").pathname).toBe("/masuk");

    const signedIn = new NextRequest("http://127.0.0.1:43123/onboarding", {
      headers: { cookie: `${SESSION_COOKIE}=token` },
    });
    const allowed = await redirectSignedOut(signedIn, async () => "customer");
    expect(allowed.headers.get("location")).toBeNull();
    expect(allowed.headers.get("x-middleware-next")).toBe("1");

    const masuk = new NextRequest("http://127.0.0.1:43123/masuk");
    const publicPage = await redirectSignedOut(masuk, async () => {
      throw new Error("lookup should not run");
    });
    expect(publicPage.headers.get("location")).toBeNull();
  });
});
