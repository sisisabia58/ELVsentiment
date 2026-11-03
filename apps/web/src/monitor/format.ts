const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const numberFormat = new Intl.NumberFormat("id-ID");

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatSigned(value: number): string {
  const rounded = Math.round(value);
  if (rounded > 0) return `+${formatNumber(rounded)}`;
  if (rounded < 0) return `−${formatNumber(Math.abs(rounded))}`;
  return "0";
}

export function formatPercent(value: number): string {
  const percent = value <= 1 ? value * 100 : value;
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(percent)}%`;
}

function wibParts(iso: string): { day: string; month: string; year: string; hour: string; minute: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const month = MONTHS[Number(get("month")) - 1];
  if (!month) return null;
  return {
    day: String(Number(get("day"))),
    month,
    year: get("year"),
    hour: get("hour").replace(/\D/g, "").padStart(2, "0"),
    minute: get("minute").replace(/\D/g, "").padStart(2, "0"),
  };
}

export function formatWib(iso: string): string {
  const parts = wibParts(iso);
  if (!parts) return iso;
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}.${parts.minute} WIB`;
}

export function formatWibClock(iso: string): string {
  const parts = wibParts(iso);
  if (!parts) return iso;
  return `${parts.hour}.${parts.minute} WIB`;
}

export function formatRelative(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Waktu tidak tersedia";
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  const abs = Math.abs(minutes);
  const rtf = new Intl.RelativeTimeFormat("id-ID", { numeric: "auto" });
  if (abs < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  return rtf.format(days, "day");
}

export function initialsFrom(name: string): string {
  const words = name.replace(/^@/, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase("id-ID") ?? "")
    .join("");
}

export function cooldownClock(retryAt: string, now: Date): string {
  const ms = new Date(retryAt).getTime() - now.getTime();
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export type ChangeTone = "good" | "bad" | "flat" | "none";

export function describeChange(
  change: number | null,
  higherIsBetter: boolean,
): { tone: ChangeTone; direction: "lebih banyak" | "lebih sedikit" | "tetap" | null } {
  if (change === null) return { tone: "none", direction: null };
  if (change === 0) return { tone: "flat", direction: "tetap" };
  const up = change > 0;
  const good = up === higherIsBetter;
  return { tone: good ? "good" : "bad", direction: up ? "lebih banyak" : "lebih sedikit" };
}
