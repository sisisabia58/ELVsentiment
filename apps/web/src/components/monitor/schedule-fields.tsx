"use client";

import { SCHEDULE_ZONE_HINT } from "@/monitor/copy";
import type { ScheduleChoice } from "@/monitor/schedule-choice";

export function clockFromMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function minuteFromClock(value: string): number {
  const [hour, minute] = value.split(":");
  const total = Number(hour) * 60 + Number(minute);
  if (!Number.isFinite(total)) return 8 * 60;
  return Math.min(1439, Math.max(0, total));
}

export function ScheduleFields(props: { value: ScheduleChoice; onChange: (next: ScheduleChoice) => void }) {
  const mode = props.value.mode === "off" ? "off" : props.value.mode === "daily" ? "daily" : String(props.value.hours);
  const minute = props.value.mode === "daily" ? props.value.minute : 8 * 60;
  function choose(next: string) {
    if (next === "off") props.onChange({ mode: "off", intervalHours: 6 });
    else if (next === "daily") props.onChange({ mode: "daily", minute });
    else if (next === "12" || next === "24") props.onChange({ mode: "interval", hours: Number(next) as 12 | 24 });
    else props.onChange({ mode: "interval", hours: 6 });
  }
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">Jadwal pengumpulan</legend>
      {[
        ["off", "Nonaktif"],
        ["6", "Setiap 6 jam"],
        ["12", "Setiap 12 jam"],
        ["24", "Setiap 24 jam"],
        ["daily", "Harian pada jam tertentu"],
      ].map(([value, label]) => (
        <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="jadwal" value={value} checked={mode === value} onChange={() => choose(value)} />
          {label}
        </label>
      ))}
      {props.value.mode === "daily" ? (
        <label className="mt-2 block text-sm">
          Jam (WIB)
          <input
            type="time"
            aria-label="Jam harian WIB"
            value={clockFromMinute(props.value.minute)}
            onChange={(event) => props.onChange({ mode: "daily", minute: minuteFromClock(event.target.value) })}
            className="mt-1 block h-11 rounded-lg border border-input-border bg-surface px-3"
          />
        </label>
      ) : null}
      <p className="text-xs text-muted-foreground">{SCHEDULE_ZONE_HINT}</p>
    </fieldset>
  );
}
