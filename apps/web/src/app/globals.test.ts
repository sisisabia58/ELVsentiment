import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = path.join(import.meta.dirname, "globals.css");
const css = readFileSync(cssPath, "utf8");

describe("globals.css", () => {
  it("points the sans font at Geist and does not copy dark tokens onto :root", () => {
    expect(css).toContain("--font-sans: var(--font-inter)");
    expect(css).not.toContain("@media (prefers-color-scheme: dark)");
  });

  it("lets dark utilities follow the system theme", () => {
    expect(css).not.toContain("@custom-variant dark (&:is(.dark *))");
  });

  it("gives checkboxes and radios a 44px touch target and lets text fields shrink", () => {
    expect(css).toMatch(/input\[type="checkbox"\][\s\S]*min-width:\s*44px/);
    expect(css).toMatch(/input\[type="radio"\][\s\S]*min-height:\s*44px/);
    expect(css).toMatch(/min-width:\s*0/);
  });
});
