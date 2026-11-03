export type ScheduleChoice =
  | { mode: "off"; intervalHours: number }
  | { mode: "interval"; hours: 6 | 12 | 24 }
  | { mode: "daily"; minute: number };

const CHOICES = [6, 12, 24] as const;

export function isIntervalHours(value: number): value is 6 | 12 | 24 {
  return (CHOICES as readonly number[]).includes(value);
}

export function choiceFromRow(row: {
  enabled: boolean;
  intervalHours: number;
  cadence: string | null;
  dailyMinute: number | null;
}): ScheduleChoice {
  if (!row.enabled) return { mode: "off", intervalHours: row.intervalHours };
  if (row.cadence === "daily" && row.dailyMinute !== null) return { mode: "daily", minute: row.dailyMinute };
  if (isIntervalHours(row.intervalHours)) return { mode: "interval", hours: row.intervalHours };
  return { mode: "interval", hours: 6 };
}

export function choiceLabel(choice: ScheduleChoice): string {
  if (choice.mode === "off") return "Nonaktif";
  if (choice.mode === "daily") return "Harian pada jam tertentu";
  if (choice.hours === 6) return "Setiap 6 jam";
  if (choice.hours === 12) return "Setiap 12 jam";
  return "Setiap 24 jam";
}

export function jakartaParts(now: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

export function nextDailyInstant(minuteOfDay: number, now: Date): Date {
  const minute = Math.min(1439, Math.max(0, Math.floor(minuteOfDay)));
  const parts = jakartaParts(now);
  const current = parts.hour * 60 + parts.minute;
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour - 7, mins, 0));
  if (current >= minute) base.setUTCDate(base.getUTCDate() + 1);
  return base;
}

export function toPersist(choice: ScheduleChoice): {
  enabled: boolean;
  intervalHours: number;
  cadence: "interval" | "daily";
  dailyMinute: number | null;
} {
  if (choice.mode === "off") {
    return { enabled: false, intervalHours: Math.max(6, choice.intervalHours), cadence: "interval", dailyMinute: null };
  }
  if (choice.mode === "daily") {
    return { enabled: true, intervalHours: 24, cadence: "daily", dailyMinute: choice.minute };
  }
  return { enabled: true, intervalHours: choice.hours, cadence: "interval", dailyMinute: null };
}
