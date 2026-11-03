export type RangeKey = "7" | "30" | "90";

export type RangeWindow = {
  key: RangeKey;
  start: Date;
  end: Date;
  previousStart: Date;
  days: string[];
};

function part(date: Date, type: Intl.DateTimeFormatPartTypes): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jakarta",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .find((item) => item.type === type)?.value ?? ""
  );
}

export function jakartaDate(date: Date): string {
  const year = part(date, "year");
  const month = part(date, "month");
  const day = part(date, "day");
  return `${year}-${month}-${day}`;
}

export function jakartaStart(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, -7, 0, 0));
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function parseRangeKey(value: string | undefined): RangeKey {
  if (value === "30" || value === "90") return value;
  return "7";
}

export function rangeWindow(key: RangeKey, now: Date): RangeWindow {
  const length = Number(key);
  const today = jakartaDate(now);
  const startDay = addDays(today, -(length - 1));
  const days: string[] = [];
  for (let index = 0; index < length; index += 1) days.push(addDays(startDay, index));
  const start = jakartaStart(startDay);
  const end = jakartaStart(addDays(today, 1));
  const previousStart = jakartaStart(addDays(startDay, -length));
  return { key, start, end, previousStart, days };
}

export function inWindow(iso: string, start: Date, end: Date): boolean {
  const time = new Date(iso).getTime();
  return time >= start.getTime() && time < end.getTime();
}
