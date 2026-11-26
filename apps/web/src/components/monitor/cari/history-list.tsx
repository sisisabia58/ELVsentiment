"use client";

import Link from "next/link";
import { Clock } from "lucide-react";
import { formatRelative } from "@/monitor/format";
import type { SearchHistoryRow } from "@/monitor/search/load";
import { StanceChip } from "./stance-chip";

export function HistoryList(props: { rows: SearchHistoryRow[]; now?: Date; aiEnabled?: boolean; recent?: boolean }) {
  const now = props.now ?? new Date();
  const aiEnabled = props.aiEnabled ?? false;
  return (
    <section className="min-w-0 rounded-xl bg-surface shadow-card">
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 border-b border-border px-4 py-1 sm:px-5">
        <h2 className="text-base font-semibold tracking-tight text-foreground">Pencarian terakhir</h2>
        {props.recent ? (
          <Link
            href="/cari/riwayat"
            className="workspace-feedback -mr-2 inline-flex min-h-11 min-w-11 items-center rounded-lg px-2 text-sm font-medium text-primary hover:bg-info-bg"
          >
            Lihat semua
          </Link>
        ) : null}
      </div>
      {props.rows.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
          {props.recent
            ? "Belum ada pencarian. Coba kata kunci pertama Anda."
            : "Belum ada pencarian. Mulai dari halaman Cari sekarang."}
        </p>
      ) : (
        <ul className="divide-y divide-border px-4 sm:px-5">
          {props.rows.map((row) => (
            <li key={row.id} className="grid min-w-0 gap-y-1 py-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-x-5">
              <Link href={`/cari/${row.id}`} className="workspace-feedback -ml-2 flex min-h-11 min-w-11 items-start gap-2.5 rounded-lg px-2 py-2.5 font-medium text-foreground hover:bg-surface-subtle hover:text-primary">
                <Clock className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 wrap-anywhere">{row.query}</span>
              </Link>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pb-2 pl-6.5 text-xs text-muted-foreground md:justify-end md:p-0">
                <span>{row.resultCount} hasil · {row.sourceCount} sumber</span>
                {aiEnabled && row.stance ? <StanceChip stance={row.stance} /> : null}
                <time className="md:w-20 md:text-right" dateTime={row.createdAt}>
                  {formatRelative(row.createdAt, now)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
