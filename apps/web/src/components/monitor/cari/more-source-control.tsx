import { Plus } from "lucide-react";
import type { MoreSourceState } from "@/monitor/search/more-source";
import { platformName } from "./platform-tile";

export type MoreSourceActions = {
  request: (platform: string, generation: number) => void;
  busy: (platform: string) => boolean;
  errors: Partial<Record<string, string>>;
};

function pagingFeedback(platform: string, more: MoreSourceState, actions: MoreSourceActions) {
  const pending = actions.busy(platform) || more.state === "pending";
  const error = actions.errors[platform] ?? (more.state === "failed" ? "Gagal mengambil hasil tambahan." : "");
  const exhausted = more.state === "exhausted" ? "Tidak ada halaman tambahan." : "";
  const added = more.added;
  const outcome = added === null ? "" : added === 0 ? "Tidak ada hasil cocok tambahan." : `+${added} hasil cocok`;
  return { pending, error, exhausted, added, message: error || [outcome, exhausted].filter(Boolean).join(" · ") };
}

export function MoreSourceStatus({ platform, more, actions }: {
  platform: string;
  more: MoreSourceState;
  actions: MoreSourceActions;
}) {
  const { pending, error, exhausted, added } = pagingFeedback(platform, more, actions);
  const outcome = added === null ? "" : added === 0
    ? "Tidak ada hasil cocok tambahan."
    : `${added} hasil cocok ditambahkan.`;
  const message = pending ? "Sedang mencari hasil tambahan." : error || [outcome, exhausted].filter(Boolean).join(" ");
  return <span role="status" aria-atomic="true" className="sr-only">{message ? `${platformName(platform)}. ${message}` : ""}</span>;
}

export function MoreSourceControl({ platform, more, actions }: {
  platform: string;
  more?: MoreSourceState;
  actions?: MoreSourceActions;
}) {
  if (!more || !actions) return null;
  const { pending, message } = pagingFeedback(platform, more, actions);
  const actionable = more.state === "available" || pending;
  return (
    <div className="flex min-w-0 max-w-44 flex-col items-end gap-1">
      {actionable ? (
        <button
          type="button"
          aria-label={`Cari lagi di ${platformName(platform)}`}
          aria-busy={pending}
          aria-disabled={pending}
          onClick={() => {
            if (!pending) actions.request(platform, more.generation);
          }}
          className="workspace-feedback inline-flex min-h-11 min-w-25 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-primary hover:bg-surface-subtle aria-disabled:opacity-65"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {pending ? "Mencari…" : "Cari lagi"}
        </button>
      ) : null}
      {message ? <span className="text-right text-xs leading-snug text-muted-foreground">{message}</span> : null}
    </div>
  );
}
