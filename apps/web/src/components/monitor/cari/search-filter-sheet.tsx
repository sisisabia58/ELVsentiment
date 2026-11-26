"use client";

import { useEffect, useId, useState, type RefObject } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { SlidersHorizontal, X } from "lucide-react";
import {
  DATE_LABEL,
  DATE_WINDOWS,
  LANGUAGE_FILTERS,
  LANGUAGE_LABEL,
  SORT_LABEL,
  SORT_MODES,
  type SearchFilters,
} from "@/monitor/search/filters";

const DESKTOP_MEDIA_QUERY = "(min-width: 48rem)";

function FilterGroup<Value extends string>({
  label, options, labels, selected, onChange,
}: {
  label: string;
  options: readonly Value[];
  labels: Record<Value, string>;
  selected: Value;
  onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <fieldset role="radiogroup" aria-labelledby={labelId} className="min-w-0">
      <legend id={labelId} className="text-sm font-semibold">{label}</legend>
      <div className="mt-1 grid grid-cols-2 gap-1.5">
        {options.map((value) => (
          <label
            key={value}
            className="workspace-feedback flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 text-sm hover:bg-surface-subtle has-checked:border-primary has-checked:bg-info-bg"
          >
            <input
              type="radio"
              name={labelId}
              value={value}
              checked={selected === value}
              onChange={() => onChange(value)}
              className="size-4 shrink-0 accent-primary"
            />
            <span>{labels[value]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SearchFilterSheet({ filters, onChange, onReset, desktopFocus }: {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  onReset: () => void;
  desktopFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !window.matchMedia) return;
    const desktop = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    closeOnDesktop();
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className="workspace-feedback inline-flex min-h-11 min-w-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-subtle md:hidden"
        aria-label="Filter pencarian"
      >
        <SlidersHorizontal className="size-4" aria-hidden="true" />
        Filter
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-slate-950/45 transition-opacity duration-(--motion-duration) data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup
          finalFocus={() => window.matchMedia?.(DESKTOP_MEDIA_QUERY).matches ? desktopFocus?.current ?? true : true}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[calc(100dvh-env(safe-area-inset-top,0px))] flex-col rounded-t-2xl border border-border bg-surface pb-[env(safe-area-inset-bottom,0px)] shadow-float transition-transform duration-(--motion-duration) ease-out data-ending-style:translate-y-full data-starting-style:translate-y-full motion-reduce:transition-none"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
            <Dialog.Title className="text-base font-semibold">Filter pencarian</Dialog.Title>
            <Dialog.Close
              className="workspace-feedback grid size-11 place-items-center rounded-lg hover:bg-surface-subtle"
              aria-label="Tutup filter"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="grid gap-4 overflow-y-auto overscroll-contain p-4">
            <FilterGroup label="Tanggal" options={DATE_WINDOWS} labels={DATE_LABEL} selected={filters.dateWindow}
              onChange={(dateWindow) => onChange({ ...filters, dateWindow })} />
            <FilterGroup label="Urutkan" options={SORT_MODES} labels={SORT_LABEL} selected={filters.sort}
              onChange={(sort) => onChange({ ...filters, sort })} />
            <FilterGroup label="Bahasa" options={LANGUAGE_FILTERS} labels={LANGUAGE_LABEL} selected={filters.language}
              onChange={(language) => onChange({ ...filters, language })} />
            <button
              type="button"
              onClick={onReset}
              className="workspace-feedback min-h-11 min-w-11 justify-self-start rounded-lg px-3 text-sm font-medium text-primary hover:bg-surface-subtle"
            >
              Reset filter
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
