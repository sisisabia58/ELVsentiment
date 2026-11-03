import { describe, expect, it } from "vitest";
import { sessionCookie, sessionCookieOptions } from "./accounts";

describe("session cookie", () => {
  it("adds Secure in production and on HTTPS, and leaves it off for plain HTTP dev", () => {
    const token = "session-token";
    const production = sessionCookie(token, { nodeEnv: "production", protocol: "http", forwardedProto: "http" });
    const httpsInDev = sessionCookie(token, {
      nodeEnv: "development",
      protocol: "http",
      forwardedProto: "https",
    });
    const httpsProtocolInDev = sessionCookie(token, { nodeEnv: "development", protocol: "https:" });
    const forwardedChain = sessionCookie(token, {
      nodeEnv: "development",
      protocol: "http",
      forwardedProto: "https, http",
    });
    const httpInDev = sessionCookie(token, { nodeEnv: "development", protocol: "http", forwardedProto: "http" });

    for (const cookie of [production, httpsInDev, httpsProtocolInDev, forwardedChain, httpInDev]) {
      expect(cookie.startsWith(`sm_session=${token}`)).toBe(true);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
    }
    expect(production).toContain("Secure");
    expect(httpsInDev).toContain("Secure");
    expect(httpsProtocolInDev).toContain("Secure");
    expect(forwardedChain).toContain("Secure");
    expect(httpInDev).not.toContain("Secure");
  });

  it("exposes the same attributes as options for cookies().set", () => {
    const base = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 1209600 };
    expect(sessionCookieOptions({ nodeEnv: "production", forwardedProto: "http" })).toEqual({ ...base, secure: true });
    expect(sessionCookieOptions({ nodeEnv: "development", forwardedProto: "https, http" })).toEqual({
      ...base,
      secure: true,
    });
    expect(sessionCookieOptions({ nodeEnv: "development", protocol: "http" })).toEqual({ ...base, secure: false });
  });
});
