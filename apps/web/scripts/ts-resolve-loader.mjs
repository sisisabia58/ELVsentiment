// Usage: node --experimental-strip-types --import ./scripts/ts-resolve-loader.mjs <file.mts>
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
