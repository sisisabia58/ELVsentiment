import type { ReactNode } from "react";
import { Activity } from "lucide-react";
import { cn } from "cn";
import { describeChange, formatNumber, formatSigned } from "@/monitor/format";

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Activity className="size-4" strokeWidth={2.5} aria-hidden="true" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-foreground">Sentiment Monitor</span>
    </span>
  );
}

export function Panel(props: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="card"
      className={cn(
        "flex min-w-0 flex-col rounded-[14px] border border-border bg-surface p-4 shadow-card lg:p-5",
        props.className,
      )}
    >
      {(props.title || props.actions) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {props.title ? <h2 className="text-[15px] font-semibold leading-6 text-foreground">{props.title}</h2> : null}
            {props.subtitle ? <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{props.subtitle}</p> : null}
          </div>
          {props.actions}
        </header>
      )}
      <div className="min-w-0 flex-1">{props.children}</div>
      {props.footer ? <footer className="mt-4 border-t border-border pt-3">{props.footer}</footer> : null}
    </section>
  );
}

export function PageHeader(props: { title: string; subtitle?: string; meta?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{props.title}</h1>
        {props.subtitle ? <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{props.subtitle}</p> : null}
        {props.meta ? <p className="mt-2 text-[13px] text-muted-foreground">{props.meta}</p> : null}
      </div>
      {props.actions ? (
        <div data-page-actions className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-2 lg:w-auto">
          {props.actions}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState(props: { title: string; body: string; action?: ReactNode; note?: string }) {
  return (
    <Panel>
      <div className="flex flex-col items-center px-4 py-12 text-center">
        <h2 className="text-[15px] font-semibold text-foreground">{props.title}</h2>
        <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{props.body}</p>
        {props.action ? <div className="mt-6">{props.action}</div> : null}
        {props.note ? <p className="mt-4 text-xs text-muted-foreground">{props.note}</p> : null}
      </div>
    </Panel>
  );
}

export function Sparkline(props: { values: Array<number | null>; className?: string }) {
  const nums = props.values.filter((value): value is number => value !== null);
  if (nums.length < 2) return null;
  const width = 96;
  const height = 36;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = width / (props.values.length - 1);
  let path = "";
  let started = false;
  props.values.forEach((value, index) => {
    if (value === null) {
      started = false;
      return;
    }
    const x = index * step;
    const y = height - 3 - ((value - min) / span) * (height - 6);
    path += `${started ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    started = true;
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={props.className} aria-hidden="true">
      <path d={path.trim()} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ChangeLine(props: { change: number | null; higherIsBetter: boolean; periodLabel: string; unit?: string }) {
  const described = describeChange(props.change, props.higherIsBetter);
  if (props.change === null || described.direction === null) {
    return <p className="mt-3 text-[12.5px] text-muted-foreground">Belum ada pembanding</p>;
  }
  const tone =
    described.tone === "good"
      ? "bg-positif-bg text-positif"
      : described.tone === "bad"
        ? "bg-negatif-bg text-negatif"
        : "bg-surface-subtle text-netral";
  const amount = `${props.change > 0 ? "+" : props.change < 0 ? "−" : ""}${formatNumber(Math.abs(props.change))}${props.unit ? ` ${props.unit}` : ""}`;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground">
      <span className={cn("inline-flex h-5 items-center rounded-md px-1.5 font-medium tabular-nums", tone)}>{amount}</span>
      <span>{described.direction}</span>
      <span>dari {props.periodLabel}</span>
    </p>
  );
}

export function ScoreValue(props: { value: number | null }) {
  if (props.value === null) return <span className="text-[32px] font-semibold leading-none tracking-tight text-foreground">—</span>;
  return <span className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-foreground">{formatSigned(props.value)}</span>;
}

export function SentimentTag(props: { sentiment: "positive" | "neutral" | "negative" | null }) {
  if (!props.sentiment) return null;
  const map = {
    positive: { label: "Positif", className: "bg-positif-bg text-positif" },
    neutral: { label: "Netral", className: "bg-netral-bg text-netral" },
    negative: { label: "Negatif", className: "bg-negatif-bg text-negatif" },
  } as const;
  const item = map[props.sentiment];
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", item.className)}>{item.label}</span>;
}

export function SourceMark(props: { source: "x" | "threads" }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <span className="grid size-4 place-items-center rounded-full bg-foreground text-[9px] font-semibold text-primary-foreground" aria-hidden="true">
        {props.source === "x" ? "X" : "T"}
      </span>
      {props.source === "x" ? "X" : "Threads"}
    </span>
  );
}
