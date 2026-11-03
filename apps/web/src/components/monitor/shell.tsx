"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  CircleHelp,
  Database,
  FolderKanban,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";
import { projectHref } from "@/monitor/links";
import { Wordmark } from "./bits";

const NAV = [
  { href: "/dasbor", label: "Ringkasan", icon: LayoutDashboard, count: null },
  { href: "/sebutan", label: "Sebutan", icon: MessageSquareText, count: null },
  { href: "/perlu-perhatian", label: "Perlu perhatian", icon: TriangleAlert, count: "attention" as const },
  { href: "/belum-yakin", label: "Belum yakin", icon: CircleHelp, count: "uncertain" as const },
  { href: "/pengumpulan", label: "Pengumpulan", icon: Database, count: null },
  { href: "/proyek", label: "Proyek", icon: FolderKanban, count: null },
];

export function WorkspaceShell(props: {
  active: string;
  projectId: string | null;
  projectName: string | null;
  projects: { id: string; name: string; initials: string }[];
  accountName: string;
  accountEmail: string;
  initials: string;
  attention: number;
  uncertain: number;
  logout?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const counts = { attention: props.attention, uncertain: props.uncertain };
  const nav = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-4">
        <Wordmark />
      </div>
      <div className="px-3">
        <details className="group">
          <summary className="flex min-h-[44px] min-w-[44px] max-w-full cursor-pointer list-none items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 shadow-card">
            <span className="grid size-7 place-items-center rounded-md bg-warning-bg text-[11px] font-semibold text-warning">
              {props.projects.find((project) => project.id === props.projectId)?.initials ?? "—"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] leading-4 text-muted-foreground">Proyek</span>
              <span className="block truncate text-[13px] font-medium text-foreground">
                {props.projectName ?? "Belum ada proyek"}
              </span>
            </span>
          </summary>
          <div className="mt-1 rounded-lg border border-border bg-surface p-1 shadow-float">
            {props.projects.map((project) => (
              <Link
                key={project.id}
                href={projectHref("/dasbor", project.id)}
                className="flex min-h-[44px] min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-surface-subtle"
                aria-current={project.id === props.projectId ? "true" : undefined}
              >
                <span className="truncate">{project.name}</span>
              </Link>
            ))}
            <Link href="/proyek" className="flex min-h-[44px] min-w-0 max-w-full items-center rounded-md px-2 text-sm text-muted-foreground hover:bg-surface-subtle">
              Semua proyek
            </Link>
          </div>
        </details>
      </div>
      <nav aria-label="Navigasi utama" className="mt-5 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        <p className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">PANTAU</p>
        {NAV.map((item, index) => {
          const Icon = item.icon;
          const active = props.active === item.href;
          const section = index === 4 ? <p className="px-3 pb-1 pt-4 text-[11px] font-semibold tracking-wide text-muted-foreground">KELOLA</p> : null;
          const count = item.count ? counts[item.count] : null;
          return (
            <div key={item.href}>
              {section}
            <Link
              href={projectHref(item.href, props.projectId)}
              aria-current={active ? "page" : undefined}
              onClick={() => setOpen(false)}
              className={cn(
                "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium lg:h-10",
                active ? "bg-info-bg text-primary" : "text-muted-foreground hover:bg-surface-subtle hover:text-foreground",
              )}
            >
              <Icon className={cn("size-[18px]", active ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
              <span className="flex-1 truncate">{item.label}</span>
              {count !== null ? (
                <span
                  className="rounded-full bg-surface-subtle px-1.5 text-xs font-medium tabular-nums text-foreground"
                  aria-label={
                    item.count === "attention" ? `${count} sebutan belum dilihat` : `${count} penilaian belum diselesaikan`
                  }
                >
                  {count}
                </span>
              ) : null}
            </Link>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-lg p-2">
          <span className="grid size-8 place-items-center rounded-full bg-info-bg text-xs font-semibold text-primary">
            {props.initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-foreground">{props.accountName}</span>
            <span className="block text-xs text-muted-foreground">Pemilik</span>
          </span>
        </div>
        <div className="mt-1 flex flex-col [&_button]:h-11 [&_button]:min-h-11 [&_button]:w-full [&_button]:justify-start [&_button]:px-2">
          <Link href="/akun" className="flex min-h-11 items-center rounded-md px-2 text-sm text-foreground hover:bg-surface-subtle">
            Profil
          </Link>
          {props.logout}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <a href="#konten" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-surface focus:px-3 focus:py-2">
        Lewati ke konten
      </a>
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-border bg-surface lg:block">{nav}</aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 min-w-0 items-center justify-between border-b border-border bg-surface px-2 lg:hidden">
          <button type="button" className="grid size-11 place-items-center" aria-label="Buka menu navigasi" onClick={() => setOpen(true)}>
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <Wordmark />
          <span className="size-11" />
        </header>
        <main id="konten" className="min-w-0 flex-1">
          {props.children}
        </main>
      </div>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" className="absolute inset-0 bg-foreground/40" aria-label="Tutup menu" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[248px] bg-surface shadow-float">
            <button type="button" className="absolute right-2 top-2 grid size-11 place-items-center" aria-label="Tutup menu" onClick={() => setOpen(false)}>
              <X className="size-5" />
            </button>
            {nav}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

export function Frame(props: {
  active: string;
  workspace: {
    displayName: string;
    email: string;
    initials: string;
    project: { id: string; name: string; initials: string } | null;
    projects: { id: string; name: string; initials: string }[];
    mentions: { attentionUnread: boolean; bucket: string; confirmed: boolean; corrected: boolean }[];
  };
  logout?: ReactNode;
  children: ReactNode;
}) {
  const attention = props.workspace.mentions.filter((mention) => mention.attentionUnread).length;
  const uncertain = props.workspace.mentions.filter(
    (mention) => mention.bucket === "not_sure" && !mention.confirmed && !mention.corrected,
  ).length;
  return (
    <WorkspaceShell
      active={props.active}
      projectId={props.workspace.project?.id ?? null}
      projectName={props.workspace.project?.name ?? null}
      projects={props.workspace.projects}
      accountName={props.workspace.displayName}
      accountEmail={props.workspace.email}
      initials={props.workspace.initials}
      attention={attention}
      uncertain={uncertain}
      logout={props.logout}
    >
      <div className="mx-auto w-full max-w-[1320px] px-4 pb-28 pt-5 lg:px-8 lg:pt-8">{props.children}</div>
    </WorkspaceShell>
  );
}
