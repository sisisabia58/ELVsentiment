"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function CollectionControls(props: {
  lastSeenAt: string | null;
  now: string;
  staleSeconds: number;
  manualBlocked: boolean;
  onRunNow: () => void | Promise<{ ok: boolean } | void>;
}) {
  const [queued, setQueued] = useState(false);
  const stale =
    props.lastSeenAt === null ||
    new Date(props.now).getTime() - new Date(props.lastSeenAt).getTime() > props.staleSeconds * 1000;
  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base leading-snug font-medium">Pengumpulan</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p>{stale ? "Pengumpul data sedang tidak aktif" : "Pengumpul data aktif"}</p>
        {stale ? <p>Kumpulkan sekarang akan memasukkan pekerjaan ke antrean.</p> : null}
        {props.manualBlocked ? <p>Tunggu 15 menit sebelum mengumpulkan lagi.</p> : null}
        {queued ? <p>Pekerjaan masuk antrean.</p> : null}
        <Button
          type="button"
          disabled={props.manualBlocked}
          onClick={() => {
            if (props.manualBlocked) return;
            void Promise.resolve(props.onRunNow())
              .then((result) => {
                if (result && result.ok) setQueued(true);
              })
              .catch(() => undefined);
          }}
        >
          Kumpulkan sekarang
        </Button>
      </CardContent>
    </Card>
  );
}
