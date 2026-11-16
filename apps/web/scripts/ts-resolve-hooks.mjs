// Adds .ts/.tsx resolution for extensionless relative imports so the dev-only
// .mts seeders can import app TypeScript directly under `node --experimental-strip-types`.
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
    for (const extension of EXTENSIONS) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch {
        // try the next extension
      }
    }
    throw error;
  }
}
