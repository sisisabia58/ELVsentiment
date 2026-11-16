// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;

const pages = [
  "page.tsx",
  "riwayat/page.tsx",
  "[id]/page.tsx",
  "../pengaturan/provider/page.tsx",
] as const;

describe("cari pages opt into per-request rendering", () => {
  for (const relative of pages) {
    it(`${relative} awaits connection() before consulting the feature flag`, () => {
      const source = readFileSync(path.join(here, relative), "utf8");
      expect(source).toMatch(/from "next\/server"/);
      const connectionAt = source.indexOf("await connection()");
      const flagAt = source.indexOf("cariSekarangEnabled()");
      expect(connectionAt).toBeGreaterThan(-1);
      expect(flagAt).toBeGreaterThan(-1);
      expect(connectionAt).toBeLessThan(flagAt);
    });
  }
});
