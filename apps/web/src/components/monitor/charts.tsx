"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "@/monitor/dashboard";
import { formatNumber } from "@/monitor/format";

const COLORS = { positif: "var(--positif)", netral: "var(--netral)", negatif: "var(--negatif)" };

export function TrendChart(props: { points: ChartPoint[]; periodLabel: string }) {
  const [table, setTable] = useState(false);
  const gaps = props.points.filter((point) => point.total === null);
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <button type="button" className="inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" onClick={() => setTable(false)} aria-pressed={!table}>
          Grafik
        </button>
        <button type="button" className="inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" onClick={() => setTable(true)} aria-pressed={table}>
          Tabel
        </button>
      </div>
      {table ? (
        <div className="max-w-full min-w-0 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Tabel tren sentimen, {props.periodLabel}</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-2 font-medium">Tanggal</th>
                <th className="py-2 font-medium">Positif</th>
                <th className="py-2 font-medium">Netral</th>
                <th className="py-2 font-medium">Negatif</th>
                <th className="py-2 font-medium">Cakupan</th>
              </tr>
            </thead>
            <tbody>
              {props.points.map((point) => (
                <tr key={point.date} className="border-t border-border">
                  <td className="py-2">{point.label}</td>
                  <td className="py-2 tabular-nums">{point.positif ?? "—"}</td>
                  <td className="py-2 tabular-nums">{point.netral ?? "—"}</td>
                  <td className="py-2 tabular-nums">{point.negatif ?? "—"}</td>
                  <td className="py-2">{point.total === null ? "Tidak ada data" : "Data tercatat"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-[260px] min-h-[220px] w-full min-w-0 overflow-hidden" role="img" aria-label={`Grafik garis tren sentimen, ${props.periodLabel}. Pilih Tabel untuk melihat angka lengkap.`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={props.points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const point = payload[0]?.payload as ChartPoint;
                  return (
                    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-float">
                      <p className="font-medium">{point.label}</p>
                      {point.total === null ? (
                        <p>Tidak ada data</p>
                      ) : (
                        <p>
                          Positif {formatNumber(point.positif ?? 0)}, Netral {formatNumber(point.netral ?? 0)}, Negatif{" "}
                          {formatNumber(point.negatif ?? 0)}
                        </p>
                      )}
                    </div>
                  );
                }}
              />
              <Line type="monotone" dataKey="positif" name="Positif" stroke={COLORS.positif} strokeWidth={2.25} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="netral" name="Netral" stroke={COLORS.netral} strokeWidth={2.25} dot={false} connectNulls={false} strokeDasharray="4 3" />
              <Line type="monotone" dataKey="negatif" name="Negatif" stroke={COLORS.negatif} strokeWidth={2.25} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {!table && gaps.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Tidak ada data: {gaps.map((point) => point.label).join(", ")}</p>
      ) : null}
    </div>
  );
}

export function CompositionChart(props: { positif: number; netral: number; negatif: number }) {
  const legend = [
    { name: "Positif", value: props.positif, fill: COLORS.positif },
    { name: "Netral", value: props.netral, fill: COLORS.netral },
    { name: "Negatif", value: props.negatif, fill: COLORS.negatif },
  ];
  const data = legend.filter((entry) => entry.value > 0);
  const total = props.positif + props.netral + props.negatif;
  return (
    <div>
      <div className="h-[220px]" role="img" aria-label="Komposisi sentimen">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={58} outerRadius={80} stroke="none">
              {data.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {legend.map((entry) => (
          <li key={entry.name} className="flex justify-between">
            <span>{entry.name}</span>
            <span className="tabular-nums">
              {formatNumber(entry.value)}
              {total > 0 ? ` · ${formatNumber(Math.round((entry.value / total) * 100))}%` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VolumeChart(props: { points: ChartPoint[] }) {
  const [table, setTable] = useState(false);
  const gaps = props.points.filter((point) => point.total === null);
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <button type="button" className="inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" onClick={() => setTable(false)} aria-pressed={!table}>
          Grafik
        </button>
        <button type="button" className="inline-flex min-h-[44px] min-w-[44px] max-w-full items-center text-sm font-medium text-primary" onClick={() => setTable(true)} aria-pressed={table}>
          Tabel
        </button>
      </div>
      {table ? (
        <div className="max-w-full min-w-0 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Tabel jumlah sebutan dinilai</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-2 font-medium">Tanggal</th>
                <th className="py-2 font-medium">Jumlah</th>
                <th className="py-2 font-medium">Cakupan</th>
              </tr>
            </thead>
            <tbody>
              {props.points.map((point) => (
                <tr key={point.date} className="border-t border-border">
                  <td className="py-2">{point.label}</td>
                  <td className="py-2 tabular-nums">{point.total === null ? "—" : formatNumber(point.total)}</td>
                  <td className="py-2">{point.total === null ? "Tidak ada data" : "Data tercatat"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-[220px] min-h-[220px]" role="img" aria-label="Jumlah sebutan dinilai. Pilih Tabel untuk melihat angka lengkap.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={props.points}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const point = payload[0]?.payload as ChartPoint;
                  return (
                    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-float">
                      <p className="font-medium">{point.label}</p>
                      <p>{point.total === null ? "Tidak ada data" : `${formatNumber(point.total)} sebutan`}</p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="total" name="Sebutan" fill="var(--primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {gaps.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">Tidak ada data: {gaps.map((point) => point.label).join(", ")}</p> : null}
    </div>
  );
}
