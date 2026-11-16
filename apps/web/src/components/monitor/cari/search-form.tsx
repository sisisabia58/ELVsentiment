"use client";

import { useState } from "react";
import { ArrowRight, ArrowUpDown, Calendar, Globe, Search } from "lucide-react";
import { cn } from "cn";
import {
  DATE_LABEL,
  DATE_SHORT_LABEL,
  DATE_WINDOWS,
  DEFAULT_FILTERS,
  LANGUAGE_LABEL,
  LANGUAGE_SHORT_LABEL,
  LANGUAGE_FILTERS,
  SORT_LABEL,
  SORT_MODES,
  validateSearchInput,
  type DateWindow,
  type LanguageFilter,
  type SearchFilters,
  type SortMode,
} from "@/monitor/search/filters";

export type SearchFormInput = { query: string; filters: SearchFilters };
export type SearchExample = { query: string; label: string };

export const EXAMPLE_SEARCHES: SearchExample[] = [
  { query: "barayam", label: "Ayam goreng viral" },
  { query: "Mandalika parfum", label: "Parfum lokal" },
  { query: "timnas indonesia", label: "Sepak bola" },
  { query: "kopi susu gula aren", label: "Tren minuman" },
];

const ERROR_COPY: Record<string, string> = {
  invalid_query: "Kata kunci minimal 2 karakter.",
  query_too_long: "Kata kunci maksimal 160 karakter.",
};

function Menu(props: {
  id: string;
  label: string;
  value: string;
  icon: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[13px] font-medium hover:bg-surface-subtle"
      >
        {props.icon}
        <span className="hidden text-muted-foreground sm:inline">{props.label}:</span>
        <span>{props.value}</span>
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {props.open ? (
        <div
          id={props.id}
          className="absolute left-0 top-11 z-30 w-48 rounded-lg border border-border bg-surface p-1 text-[13px] shadow-float"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
            {props.label.toLocaleUpperCase("id-ID")}
          </p>
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

function Option(props: { active: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left hover:bg-surface-subtle"
    >
      <span>{props.children}</span>
      <span className="text-primary" aria-hidden="true">
        {props.active ? "✓" : ""}
      </span>
    </button>
  );
}

export function SearchForm(props: {
  onSubmit: (input: SearchFormInput) => void | Promise<void>;
  pending?: boolean;
  initialQuery?: string;
  initialFilters?: SearchFilters;
  examples?: SearchExample[];
}) {
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [filters, setFilters] = useState<SearchFilters>(props.initialFilters ?? DEFAULT_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function choose<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setOpen(null);
  }

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (props.pending) return;
    const invalid = validateSearchInput(query, filters);
    if (invalid) {
      setError(ERROR_COPY[invalid] ?? ERROR_COPY.invalid_query);
      return;
    }
    setError(null);
    void props.onSubmit({ query: query.trim(), filters });
  }

  return (
    <form onSubmit={submit} className="rounded-[14px] border border-border bg-surface shadow-card">
      <div className="flex items-center gap-3 px-4 pt-3.5">
        <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="cari-query" className="sr-only">
          Kata kunci pencarian
        </label>
        <input
          id="cari-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={props.pending}
          placeholder="Cari merek, produk, atau topik… misalnya “barayam”"
          className="h-10 min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-2">
        <Menu
          id="menu-tanggal"
          label="Tanggal"
          value={DATE_SHORT_LABEL[filters.dateWindow]}
          icon={<Calendar className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
          open={open === "date"}
          onToggle={() => setOpen(open === "date" ? null : "date")}
        >
          {DATE_WINDOWS.map((value) => (
            <Option key={value} active={filters.dateWindow === value} onSelect={() => choose("dateWindow", value)}>
              {DATE_LABEL[value]}
            </Option>
          ))}
        </Menu>
        <Menu
          id="menu-urutkan"
          label="Urutkan"
          value={SORT_LABEL[filters.sort]}
          icon={<ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
          open={open === "sort"}
          onToggle={() => setOpen(open === "sort" ? null : "sort")}
        >
          {SORT_MODES.map((value) => (
            <Option key={value} active={filters.sort === value} onSelect={() => choose("sort", value)}>
              {SORT_LABEL[value]}
            </Option>
          ))}
        </Menu>
        <Menu
          id="menu-bahasa"
          label="Bahasa"
          value={LANGUAGE_SHORT_LABEL[filters.language]}
          icon={<Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
          open={open === "language"}
          onToggle={() => setOpen(open === "language" ? null : "language")}
        >
          {LANGUAGE_FILTERS.map((value) => (
            <Option key={value} active={filters.language === value} onSelect={() => choose("language", value)}>
              {LANGUAGE_LABEL[value]}
            </Option>
          ))}
        </Menu>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[12px] text-muted-foreground sm:inline">
            1 kredit · Enter untuk mencari
          </span>
          <button
            type="submit"
            aria-label="Cari"
            disabled={props.pending}
            className="grid h-10 w-10 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
          >
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-4 pb-3 text-[12.5px] text-negatif">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2.5">
        {(props.examples ?? EXAMPLE_SEARCHES).map((example) => (
          <button
            key={example.query}
            type="button"
            onClick={() => setQuery(example.query)}
            className={cn(
              "rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-surface-subtle",
            )}
          >
            <span className="font-medium text-foreground">{example.query}</span> · {example.label}
          </button>
        ))}
      </div>
    </form>
  );
}
