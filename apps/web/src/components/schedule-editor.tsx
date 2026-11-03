"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ScheduleEditor(props: {
  enabled: boolean;
  intervalHours: number;
  minIntervalHours: number;
  onSave: (value: { enabled: boolean; intervalHours: number }) => void;
}) {
  const [enabled, setEnabled] = useState(props.enabled);
  const [hours, setHours] = useState(String(props.intervalHours));
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-3">
      <h2>Jadwal pengumpulan</h2>
      <p>WIB</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Aktifkan jadwal</span>
      </label>
      <Label htmlFor="interval-hours">Setiap berapa jam</Label>
      <Input
        id="interval-hours"
        inputMode="numeric"
        value={hours}
        onChange={(event) => setHours(event.target.value)}
      />
      {error ? <p role="alert">{error}</p> : null}
      <Button
        type="button"
        onClick={() => {
          const intervalHours = Number(hours);
          if (!Number.isInteger(intervalHours) || intervalHours < props.minIntervalHours) {
            setError(`Jarak jadwal minimal ${props.minIntervalHours} jam.`);
            return;
          }
          setError(null);
          props.onSave({ enabled, intervalHours });
        }}
      >
        Simpan jadwal
      </Button>
    </section>
  );
}
