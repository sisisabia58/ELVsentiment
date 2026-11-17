"use client";

import Link from "next/link";
import { Clock } from "lucide-react";
import { formatRelative } from "@/monitor/format";
import type { SearchHistoryRow } from "@/monitor/search/load";
import { StanceChip } from "./stance-chip";

export function HistoryList(props: { rows: SearchHistoryRow[]; now?: Date; aiEnabled?: boolean }) {
  const now = props.now ?? new Date();
  const aiEnabled = props.aiEnabled ?? false;
  return (
    <section className="rounded-[14px] border border-border bg-surface shadow-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold text-foreground">Pencarian terakhir</h2>
      </div>
      {props.rows.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-muted-foreground">
          Belum ada pencarian. Mulai dari halaman Cari sekarang.
        </p>
      ) : (
        <ul className="divide-y divide-border text-[13.5px]">
          {props.rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-5 py-3">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Link href={`/cari/${row.id}`} className="min-w-0 flex-1 truncate font-medium text-foreground hover:text-primary">
                {row.query}
              </Link>
              <span className="hidden text-muted-foreground sm:inline">
                {row.resultCount} hasil · {row.sourceCount} sumber
              </span>
                {aiEnabled && row.stance ? <StanceChip stance={row.stance} /> : null}
              <span className="w-24 text-right text-[12px] text-muted-foreground">
                {formatRelative(row.createdAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
