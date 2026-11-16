import { cn } from "cn";
import { SEARCH_PLATFORM_NAME, type SearchPlatform } from "@/monitor/search/platforms";

export const PLATFORM_ORDER: SearchPlatform[] = [
  "threads",
  "tiktok",
  "youtube",
  "instagram",
  "facebook",
  "x",
  "reddit",
  "linkedin",
  "web",
];

const TILE: Record<SearchPlatform, { background: string; glyph: string }> = {
  threads: { background: "#0f172a", glyph: "@" },
  tiktok: { background: "#0f172a", glyph: "♪" },
  youtube: { background: "#dc2626", glyph: "▶" },
  instagram: { background: "linear-gradient(135deg,#f59e0b,#db2777 55%,#7c3aed)", glyph: "◎" },
  facebook: { background: "#1877f2", glyph: "f" },
  x: { background: "#0f172a", glyph: "X" },
  reddit: { background: "#ff4500", glyph: "r" },
  linkedin: { background: "#0a66c2", glyph: "in" },
  web: { background: "#475569", glyph: "W" },
};

export function platformName(platform: string): string {
  return SEARCH_PLATFORM_NAME[platform as SearchPlatform] ?? platform;
}

export function PlatformTile(props: { platform: string; size?: number; className?: string }) {
  const tile = TILE[props.platform as SearchPlatform] ?? TILE.web;
  const size = props.size ?? 20;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-grid shrink-0 place-items-center rounded-md font-semibold text-white", props.className)}
      style={{
        width: size,
        height: size,
        background: tile.background,
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
      }}
    >
      {tile.glyph}
    </span>
  );
}
