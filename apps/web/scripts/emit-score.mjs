import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(webRoot, "src");
const outRoot = path.join(webRoot, "dist");
const entry = path.join(srcRoot, "scoring/cli.ts");

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  isolatedModules: true,
  verbatimModuleSyntax: false,
};

function hasValueImport(node) {
  if (ts.isExportDeclaration(node)) return !node.isTypeOnly && Boolean(node.moduleSpecifier);
  if (!ts.isImportDeclaration(node) || !node.importClause) return ts.isImportDeclaration(node);
  if (node.importClause.isTypeOnly) return false;
  if (node.importClause.name) return true;
  const bindings = node.importClause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function relativeSpecifiers(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs = [];
  const visit = (node) => {
    const specifier = node.moduleSpecifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      specifier &&
      ts.isStringLiteral(specifier) &&
      specifier.text.startsWith(".") &&
      hasValueImport(node)
    ) {
      specs.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`cannot resolve ${spec} from ${path.relative(webRoot, fromFile)}`);
  return found;
}

function rewriteSpecifiers(code) {
  return code
    .replace(/(\bfrom\s+|\bimport\s*\(\s*)(["'])(\.[^"']+)\2/g, (match, prefix, quote, spec) => {
      if (/\.(?:js|mjs|cjs|json|node)$/.test(spec)) return match;
      return `${prefix}${quote}${spec}.js${quote}`;
    })
    .replace(/(^|\n)(\s*import\s+)(["'])(\.[^"']+)\3/g, (match, lead, prefix, quote, spec) => {
      if (/\.(?:js|mjs|cjs|json|node)$/.test(spec)) return match;
      return `${lead}${prefix}${quote}${spec}.js${quote}`;
    });
}

function emitFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const transpiled = ts.transpileModule(source, { compilerOptions, fileName: file });
  if (transpiled.diagnostics?.length) {
    const message = ts.formatDiagnostics(transpiled.diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => webRoot,
      getNewLine: () => "\n",
    });
    throw new Error(message);
  }
  const relative = path.relative(srcRoot, file).replace(/\.tsx?$/, ".js");
  const destination = path.join(outRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, rewriteSpecifiers(transpiled.outputText));
  return source;
}

const seen = new Set();
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = emitFile(file);
  for (const spec of relativeSpecifiers(file, source)) visit(resolveRelative(file, spec));
}

fs.rmSync(outRoot, { recursive: true, force: true });
visit(entry);
fs.writeFileSync(path.join(outRoot, "package.json"), '{"type":"module"}\n');
process.stdout.write(`emitted ${seen.size} files to ${path.relative(webRoot, outRoot)}\n`);
