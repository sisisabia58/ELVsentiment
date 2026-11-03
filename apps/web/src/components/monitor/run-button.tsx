"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cooldownClock } from "@/monitor/format";

export function RunButton(props: {
  label?: string;
  disabled?: boolean;
  inProgress?: boolean;
  retryAt?: string | null;
  stale?: boolean;
  note?: string | null;
  onRun: () => void | Promise<{ ok: boolean; error?: string | null } | void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!props.retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.retryAt]);
  const waiting = Boolean(props.retryAt && new Date(props.retryAt).getTime() > now);
  const blocked = props.disabled || props.inProgress || waiting || pending;
  const label = props.inProgress
    ? "Pengumpulan berjalan"
    : pending
      ? "Mengirim permintaan…"
      : waiting && props.retryAt
        ? `Bisa dijalankan lagi dalam ${cooldownClock(props.retryAt, new Date(now))}`
        : queued
          ? "Permintaan diterima"
          : (props.label ?? "Jalankan sekarang");
  return (
    <div className="flex w-full min-w-0 max-w-full flex-col items-stretch gap-1">
      <Button
        type="button"
        className="h-auto min-h-11 max-w-full whitespace-normal bg-primary px-4 text-primary-foreground hover:bg-primary/90 lg:h-10"
        disabled={blocked}
        onClick={() => {
          if (blocked) return;
          setPending(true);
          setError(null);
          void Promise.resolve(props.onRun())
            .then((result) => {
              if (result && result.ok === false) setError(result.error ?? "Perubahan belum tersimpan. Coba lagi.");
              else setQueued(true);
            })
            .catch(() => undefined)
            .finally(() => setPending(false));
        }}
      >
        {props.inProgress || pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        <span aria-live="off">{label}</span>
      </Button>
      {props.stale ? <p className="text-xs text-muted-foreground">Pengumpul data sedang tidak aktif</p> : null}
      {waiting ? <p className="text-xs text-muted-foreground">Jeda minimal antar-pengumpulan: 15 menit.</p> : null}
      {props.inProgress ? <p className="text-xs text-muted-foreground">Pengumpulan sedang berjalan. Hasil yang tersedia akan muncul di sini.</p> : null}
      {props.note ? <p className="max-w-full break-words text-xs text-muted-foreground">{props.note}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
