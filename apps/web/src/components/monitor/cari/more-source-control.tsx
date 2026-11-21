import { Plus } from "lucide-react";
import type { MoreSourceState } from "@/monitor/search/more-source";
import { platformName } from "./platform-tile";

export type MoreSourceActions = {
  request: (platform: string, generation: number) => void;
  busy: (platform: string) => boolean;
  errors: Partial<Record<string, string>>;
};

export function MoreSourceControl({ platform, more, actions, compact = false }: {
  platform: string;
  more?: MoreSourceState;
  actions?: MoreSourceActions;
  compact?: boolean;
}) {
  if (!more || !actions) return null;
  const pending = actions.busy(platform) || more.state === "pending";
  const label = `Cari lagi di ${platformName(platform)}`;
  const outcome = more.added === null ? "" : more.added === 0
    ? "Tidak ada hasil cocok tambahan."
    : `+${more.added} hasil cocok`;
  const exhausted = more.state === "exhausted" ? "Tidak ada halaman tambahan." : "";
  const message = actions.errors[platform] ?? (more.state === "failed"
    ? "Gagal mengambil hasil tambahan."
    : [outcome, exhausted].filter(Boolean).join(" · "));
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <span role={compact ? "status" : undefined} className={pending ? "sr-only" : "text-[11.5px] text-muted-foreground"}>
        {pending ? `Sedang mencari hasil tambahan di ${platformName(platform)}.` : message}
      </span>
      {more.state === "available" || pending ? (
        <button
          type="button"
          aria-label={label}
          aria-busy={pending}
          disabled={pending}
          onClick={() => actions.request(platform, more.generation)}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-primary hover:bg-surface-subtle disabled:opacity-60"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {pending ? "Mencari lagi…" : compact ? "Cari lagi" : label}
        </button>
      ) : null}
    </div>
  );
}
