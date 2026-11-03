"use client";

import { useState } from "react";
import type { ScheduleChoice } from "@/monitor/schedule-choice";
import { saveScheduleAction } from "@/app/proyek/actions";
import { ScheduleFields } from "./schedule-fields";

export function CollectionSchedule(props: { projectId: string; value: ScheduleChoice }) {
  const [value, setValue] = useState(props.value);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setMessage(null);
        void saveScheduleAction(props.projectId, value).then((result) => {
          setPending(false);
          if (result.ok) setMessage(result.message);
          else setError(result.error);
        });
      }}
    >
      <ScheduleFields value={value} onChange={setValue} />
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-foreground">{message}</p> : null}
      <button type="submit" disabled={pending} className="h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
        Simpan jadwal
      </button>
    </form>
  );
}
