"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Dialog } from "@base-ui/react/dialog";
import {
  CircleHelp,
  Database,
  FolderKanban,
  History,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  Search,
  Settings,
  TriangleAlert,
  Wallet,
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
  searchEnabled?: boolean;
  aiEnabled?: boolean;
  admin?: boolean;
  logout?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeDrawer = () => setOpen(false);

  useEffect(() => {
    if (!open || !window.matchMedia) return;
    const desktop = window.matchMedia("(min-width: 64rem)");
    const dismissOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", dismissOnDesktop);
    return () => desktop.removeEventListener("change", dismissOnDesktop);
  }, [open]);

  const counts = { attention: props.attention, uncertain: props.uncertain };
  const searchEnabled = props.searchEnabled ?? false;
  const aiEnabled = props.aiEnabled ?? false;
  const nav = (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      {searchEnabled ? (
        <div className="px-3 pb-2">
          <div className="rounded-lg border border-border bg-surface p-3 shadow-card">
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <Wallet className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                Kredit pencarian
              </span>
            </div>
            <p className="mt-1 text-[11.5px] leading-4 text-muted-foreground">
              {aiEnabled
                ? "1 kredit per pencarian · 1 kredit per pertanyaan"
                : "1 kredit per pencarian"}
            </p>
          </div>
        </div>
      ) : null}
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
                onNavigate={closeDrawer}
                className="flex min-h-[44px] min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-surface-subtle"
                aria-current={project.id === props.projectId ? "true" : undefined}
              >
                <span className="truncate">{project.name}</span>
              </Link>
            ))}
            <Link href="/proyek" onNavigate={closeDrawer} className="flex min-h-[44px] min-w-0 max-w-full items-center rounded-md px-2 text-sm text-muted-foreground hover:bg-surface-subtle">
              Semua proyek
            </Link>
          </div>
        </details>
      </div>
      <nav aria-label="Navigasi utama" className="mt-5 space-y-1 px-3 pb-4">
        {searchEnabled ? (
          <>
            <p className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">CARI</p>
            {[
              { href: "/cari", label: "Cari sekarang", icon: Search },
              { href: "/cari/riwayat", label: "Riwayat pencarian", icon: History },
            ].map((item) => {
              const Icon = item.icon;
              const active = props.active === item.href || (item.href === "/cari" && props.active.startsWith("/cari/") && props.active !== "/cari/riwayat");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onNavigate={closeDrawer}
                  className={cn(
                    "workspace-feedback flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium",
                    active ? "bg-info-bg font-semibold text-primary" : "text-muted-foreground hover:bg-surface-subtle hover:text-foreground",
                  )}
                >
                  <Icon className={cn("size-[18px]", active ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
                  <span className="flex-1 truncate">{item.label}</span>
                </Link>
              );
            })}
            <p className="px-3 pb-1 pt-4 text-[11px] font-semibold tracking-wide text-muted-foreground">PANTAU</p>
          </>
        ) : (
          <p className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">PANTAU</p>
        )}
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
                onNavigate={closeDrawer}
                className={cn(
                  "workspace-feedback flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium",
                  active ? "bg-info-bg font-semibold text-primary" : "text-muted-foreground hover:bg-surface-subtle hover:text-foreground",
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
      <div className="mt-auto border-t border-border p-3">
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
          {props.admin ? (
            <Link
              href="/pengaturan/provider"
              onNavigate={closeDrawer}
              aria-current={props.active === "/pengaturan/provider" ? "page" : undefined}
              className="workspace-feedback flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-surface-subtle aria-[current=page]:bg-info-bg aria-[current=page]:text-primary"
            >
              <Settings className="size-4 text-muted-foreground" aria-hidden="true" />
              Pengaturan provider
            </Link>
          ) : null}
          <Link
            href="/akun"
            onNavigate={closeDrawer}
            aria-current={props.active === "/akun" ? "page" : undefined}
            className="workspace-feedback flex min-h-11 items-center rounded-md px-2 text-sm text-foreground hover:bg-surface-subtle aria-[current=page]:bg-info-bg aria-[current=page]:text-primary"
          >
            Profil
          </Link>
          {props.logout}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh min-w-0 bg-background text-foreground">
      <a href="#konten" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-50 focus:flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-surface focus:px-3">
        Lewati ke konten
      </a>
      <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-(--workspace-header-height) shrink-0 items-center px-5">
          <Wordmark />
        </div>
        {nav}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <header className="flex h-(--workspace-header-height) min-w-0 items-center gap-2 border-b border-border bg-surface px-2 lg:hidden">
            <Dialog.Trigger ref={trigger} className="workspace-feedback grid size-11 shrink-0 place-items-center rounded-lg hover:bg-surface-subtle" aria-label="Buka menu navigasi">
              <Menu className="size-5" aria-hidden="true" />
            </Dialog.Trigger>
            <Wordmark />
            {searchEnabled ? (
              <span className="ml-auto shrink-0 rounded-full bg-info-bg px-2 py-1 text-xs font-medium tabular-nums text-info">
                1 kr / cari
              </span>
            ) : null}
          </header>
          <Dialog.Portal>
            <Dialog.Backdrop className="workspace-drawer-backdrop fixed inset-0 z-40 bg-slate-950/45 lg:hidden" />
            <Dialog.Popup
              finalFocus={trigger}
              className="workspace-drawer fixed inset-y-0 left-0 z-50 flex w-[min(19rem,calc(100vw-2.75rem))] flex-col border-r border-border bg-surface shadow-float lg:hidden"
            >
              <div className="flex h-(--workspace-header-height) shrink-0 items-center justify-between gap-2 px-3">
                <Dialog.Title className="pl-2 text-base font-semibold tracking-tight">Menu navigasi</Dialog.Title>
                <Dialog.Close className="workspace-feedback grid size-11 shrink-0 place-items-center rounded-lg hover:bg-surface-subtle" aria-label="Tutup menu">
                  <X className="size-5" aria-hidden="true" />
                </Dialog.Close>
              </div>
              {nav}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
        <main id="konten" tabIndex={-1} className="min-w-0 flex-1">
          {props.children}
        </main>
      </div>
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
    cariEnabled?: boolean;
    cariAiEnabled?: boolean;
    isAdmin?: boolean;
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
      searchEnabled={props.workspace.cariEnabled ?? false}
      aiEnabled={props.workspace.cariAiEnabled ?? false}
      admin={props.workspace.isAdmin ?? false}
      logout={props.logout}
    >
      <div className="mx-auto w-full min-w-0 max-w-[1320px] px-4 pb-20 pt-6 md:px-6 lg:px-8 lg:pt-8">{props.children}</div>
    </WorkspaceShell>
  );
}
