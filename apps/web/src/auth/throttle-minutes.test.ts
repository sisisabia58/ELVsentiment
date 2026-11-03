import { describe, expect, it } from "vitest";
import { retryMinutesFromSeconds } from "./throttle";

describe("retry minutes at the window edges", () => {
  it("rounds up and never returns zero or a negative count", () => {
    expect(retryMinutesFromSeconds(0)).toBe(1);
    expect(retryMinutesFromSeconds(-0.4)).toBe(1);
    expect(retryMinutesFromSeconds(-90)).toBe(1);
    expect(retryMinutesFromSeconds(1)).toBe(1);
    expect(retryMinutesFromSeconds(60)).toBe(1);
    expect(retryMinutesFromSeconds(61)).toBe(2);
    expect(retryMinutesFromSeconds(270)).toBe(5);
    expect(retryMinutesFromSeconds(Number.NaN)).toBe(1);
    expect(retryMinutesFromSeconds(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
