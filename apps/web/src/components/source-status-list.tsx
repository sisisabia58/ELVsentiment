"use client";

import { SOURCE_NAME, type SourceId } from "@/monitor/policy";

const STATE_LABEL = {
  ready: "Siap",
  unavailable: "Tidak tersedia",
  authorization_failed: "Otorisasi gagal",
  rate_limited: "Batas permintaan tercapai",
} as const;

const DETAIL_LABEL: Record<string, string> = {
  x_customer_cap: "Batas baca X untuk pelanggan ini tercapai. Ini bukan nol sebutan.",
  x_global_cap: "Batas baca X bersama tercapai. Ini bukan nol sebutan.",
  threads_budget: "Batas pencarian Threads tercapai. Ini bukan nol sebutan.",
};

export function SourceStatusList(props: {
  reports: {
    source: SourceId;
    state: keyof typeof STATE_LABEL;
    outcome: "success" | "failed" | "empty_unconfirmed";
    fetchedCount: number | null;
    detail?: string;
  }[];
}) {
  return (
    <ul className="flex flex-col gap-3">
      {props.reports.map((report) => (
        <li key={`${report.source}-${report.outcome}-${"detail" in report ? report.detail ?? "" : ""}`}>
          <p>{SOURCE_NAME[report.source]}</p>
          <p>
            {report.state === "unavailable"
              ? `Status ${SOURCE_NAME[report.source]}: Tidak tersedia`
              : STATE_LABEL[report.state]}
          </p>
          {report.outcome === "failed" ? <p>Pengumpulan gagal. Ini bukan nol sebutan.</p> : null}
          {report.detail && DETAIL_LABEL[report.detail] ? <p>{DETAIL_LABEL[report.detail]}</p> : null}
          {report.outcome === "empty_unconfirmed" ? (
            <p>
              Threads mengembalikan daftar kosong. Daftar kosong juga dipakai untuk kata yang dianggap sensitif, jadi ini bukan bukti bahwa tidak ada sebutan.
            </p>
          ) : null}
          {report.outcome === "success" && report.fetchedCount !== null ? (
            <p>{report.fetchedCount} kandidat baru</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
