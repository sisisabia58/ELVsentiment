export type SearchPlatform =
  | "threads"
  | "tiktok"
  | "instagram"
  | "youtube"
  | "reddit"
  | "facebook"
  | "linkedin"
  | "x"
  | "web";
export type ProviderId = "scrapeatlas" | "off";
export type ProviderMode = "keyword" | "comments";
export type SettingTarget = SearchPlatform | "comments";

export type ProviderSetting = {
  provider: ProviderId;
  fallbackProvider: ProviderId | null;
  fallbackOnFailure: boolean;
};

export const SEARCH_PLATFORMS: SearchPlatform[] = [
  "threads",
  "tiktok",
  "instagram",
  "youtube",
  "reddit",
  "facebook",
  "linkedin",
  "x",
  "web",
];

export const SEARCH_PLATFORM_NAME: Record<SearchPlatform, string> = {
  threads: "Threads",
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  reddit: "Reddit",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
  web: "Web",
};

export const PROVIDER_NAME: Record<ProviderId, string> = {
  scrapeatlas: "ScrapeAtlas",
  off: "Nonaktif",
};

const KEYWORD_CAPABILITIES: Partial<Record<SearchPlatform, ProviderId[]>> = {
  threads: ["scrapeatlas"],
  tiktok: ["scrapeatlas"],
  instagram: ["scrapeatlas"],
  youtube: ["scrapeatlas"],
  reddit: ["scrapeatlas"],
  facebook: ["scrapeatlas"],
  linkedin: ["scrapeatlas"],
  x: ["scrapeatlas"],
  web: [],
};

const COMMENTS_CAPABILITIES: Partial<Record<SearchPlatform, ProviderId[]>> = {
  threads: ["scrapeatlas"],
  tiktok: ["scrapeatlas"],
  instagram: ["scrapeatlas"],
  youtube: ["scrapeatlas"],
  facebook: ["scrapeatlas"],
  reddit: ["scrapeatlas"],
  linkedin: [],
  x: [],
  web: [],
};

export const CAPABILITIES: Record<ProviderMode, Partial<Record<SearchPlatform, ProviderId[]>>> = {
  keyword: KEYWORD_CAPABILITIES,
  comments: COMMENTS_CAPABILITIES,
};

const LAUNCH_PLATFORM_ORDER: SearchPlatform[] = [
  "threads",
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "reddit",
  "linkedin",
];

export const LAUNCH_PLATFORMS: SearchPlatform[] = [
  ...LAUNCH_PLATFORM_ORDER,
  ...SEARCH_PLATFORMS.filter((platform) => !LAUNCH_PLATFORM_ORDER.includes(platform)),
].filter((platform) => supportedProviders(platform).length > 0);

// Mirrors config/cari-providers.json, which the Python worker reads and the
// tests compare against. Next cannot bundle a file outside apps/web, so the
// defaults live here as a literal.
export const DEFAULT_PROVIDER_SETTINGS: Record<SettingTarget, ProviderSetting> = {
  threads: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  tiktok: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  instagram: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  youtube: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  reddit: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  facebook: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  linkedin: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  x: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
  web: { provider: "off", fallbackProvider: null, fallbackOnFailure: false },
  comments: { provider: "scrapeatlas", fallbackProvider: null, fallbackOnFailure: false },
};

export function supportedProviders(
  platform: string,
  mode: ProviderMode = "keyword",
): ProviderId[] {
  return CAPABILITIES[mode][platform as SearchPlatform] ?? [];
}

export function supportedForTarget(target: string): ProviderId[] {
  // Comment fetching is one global row; ScrapeAtlas is the only comments
  // provider in the matrix.
  if (target === "comments") return ["scrapeatlas"];
  return supportedProviders(target);
}

export function validateProviderChoice(
  platform: string,
  provider: string,
  fallbackProvider: string | null,
  fallbackOnFailure: boolean,
): boolean {
  if (fallbackProvider !== null || fallbackOnFailure) return false;
  return provider === "off" || supportedForTarget(platform).includes(provider as ProviderId);
}

export function resolveProviderChain(
  platform: string,
  settings: Record<SettingTarget, ProviderSetting>,
  mode: ProviderMode = "keyword",
): ProviderId[] {
  // Comment fetching has one global routing row keyed "comments"; the
  // platform only decides whether comments are supported there.
  const target: SettingTarget = mode === "comments" ? "comments" : (platform as SettingTarget);
  const setting = settings[target];
  if (!setting || setting.provider === "off") return [];
  const supported = supportedProviders(platform, mode);
  if (!supported.includes(setting.provider)) return [];
  return [setting.provider];
}
