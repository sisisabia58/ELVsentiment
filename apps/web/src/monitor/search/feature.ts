export type Env = Record<string, string | undefined>;

function flag(value: string | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  return normalized === "1" || normalized === "true";
}

export function cariSekarangEnabled(env: Env = process.env): boolean {
  return flag(env.CARI_SEKARANG_ENABLED);
}

export function cariProviderMode(env: Env = process.env): string {
  return env.CARI_PROVIDER_MODE?.trim() || "live";
}

export function cariAiProvider(env: Env = process.env): string {
  return env.CARI_AI_PROVIDER?.trim() || "demo";
}
