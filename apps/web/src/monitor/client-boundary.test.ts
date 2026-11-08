import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function isClientEntry(text: string): boolean {
  return /^\s*(?:"use client"|'use client')\s*;?/.test(text.replace(/^\uFEFF/, ""));
}

function isServerEntry(text: string): boolean {
  return /^\s*(?:"use server"|'use server')\s*;?/.test(text.replace(/^\uFEFF/, ""));
}

function moduleSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }
  return specifiers;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(srcRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const policyModule = path.join(srcRoot, "monitor", "policy.ts");

function isNodeFs(specifier: string): boolean {
  return specifier === "node:fs" || specifier === "fs";
}

function clientGraphNodeImports(): { importer: string; specifier: string; chain: string[] }[] {
  const files = sourceFiles(srcRoot);
  const entries = files.filter((file) => isClientEntry(readFileSync(file, "utf8")));
  const origin = new Map<string, string | null>(entries.map((file) => [file, null]));
  const queue = [...entries];
  const violations: { importer: string; specifier: string; chain: string[] }[] = [];

  const chainFor = (file: string): string[] => {
    const chain: string[] = [];
    let current: string | null = file;
    while (current) {
      chain.unshift(path.relative(srcRoot, current));
      current = origin.get(current) ?? null;
    }
    return chain;
  };

  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const specifier of moduleSpecifiers(file, readFileSync(file, "utf8"))) {
      if (isNodeFs(specifier)) violations.push({ importer: file, specifier, chain: chainFor(file) });
      const resolved = resolveImport(file, specifier);
      if (!resolved || origin.has(resolved)) continue;
      if (resolved === policyModule) {
        violations.push({ importer: file, specifier, chain: chainFor(file) });
        continue;
      }
      if (isServerEntry(readFileSync(resolved, "utf8"))) continue;
      origin.set(resolved, file);
      queue.push(resolved);
    }
  }

  return violations;
}

describe("client module graph", () => {
  it("does not pull node built-ins (such as node:fs) into browser chunks", () => {
    const violations = clientGraphNodeImports();
    expect(
      violations.map((violation) => `${violation.chain.join(" -> ")} -> ${violation.specifier}`),
    ).toEqual([]);
  });
});
