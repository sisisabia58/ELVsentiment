"use client";

import { useState } from "react";
import {
  PROVIDER_NAME,
  SEARCH_PLATFORM_NAME,
  type ProviderId,
  type SettingTarget,
  supportedForTarget,
  validateProviderChoice,
} from "@/monitor/search/platforms";
import type { ProviderSettingRow } from "@/monitor/search/provider-settings";

export type { ProviderSettingRow };

export type ProviderSettingDraft = {
  platform: SettingTarget;
  provider: ProviderId;
  fallbackProvider: ProviderId | null;
  fallbackOnFailure: boolean;
};

const ERROR_COPY: Record<string, string> = {
  unsupported_provider: "Pilihan tidak didukung untuk platform ini.",
  fallback_requires_provider: "Pilih penyedia cadangan sebelum mengaktifkan cadangan.",
  not_admin: "Hanya admin yang dapat mengubah penyedia.",
};

function targetLabel(target: SettingTarget): string {
  return target === "comments" ? "Komentar" : SEARCH_PLATFORM_NAME[target];
}

function ProviderRow(props: {
  row: ProviderSettingRow;
  onSave: (draft: ProviderSettingDraft) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { row, onSave } = props;
  const label = targetLabel(row.target);
  const [provider, setProvider] = useState<ProviderId>(row.provider);
  const [fallbackProvider, setFallbackProvider] = useState<ProviderId | null>(
    row.fallbackProvider,
  );
  const [fallbackOnFailure, setFallbackOnFailure] = useState(row.fallbackOnFailure);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const options = supportedForTarget(row.target);
  if (options.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-xs text-muted-foreground">Belum tersedia saat peluncuran</span>
        </div>
      </div>
    );
  }
  const supported = validateProviderChoice(
    row.target,
    provider,
    fallbackProvider,
    fallbackOnFailure,
  );
  const fallbackMissing = fallbackOnFailure && fallbackProvider === null;
  const warning = fallbackMissing
    ? ERROR_COPY.fallback_requires_provider
    : !supported
      ? ERROR_COPY.unsupported_provider
      : error
        ? (ERROR_COPY[error] ?? ERROR_COPY.unsupported_provider)
        : null;

  function chooseProvider(value: ProviderId) {
    setProvider(value);
    setSaved(false);
    setError(null);
    if (value === "off") {
      setFallbackProvider(null);
      setFallbackOnFailure(false);
    }
  }

  async function submit() {
    setError(null);
    setSaved(false);
    if (!supported || fallbackMissing) return;
    setSaving(true);
    try {
      const result = await onSave({
        platform: row.target,
        provider,
        fallbackProvider,
        fallbackOnFailure,
      });
      if (result.ok) setSaved(true);
      else setError(result.error ?? "unsupported_provider");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-sm font-medium text-foreground">{label}</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Penyedia
          <select
            aria-label={`Provider ${label}`}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-foreground"
            value={provider}
            onChange={(event) => chooseProvider(event.target.value as ProviderId)}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {PROVIDER_NAME[option]}
              </option>
            ))}
            {options.includes("off") ? null : <option value="off">{PROVIDER_NAME.off}</option>}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Cadangan
          <select
            aria-label={`Cadangan ${label}`}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-foreground"
            value={fallbackProvider ?? ""}
            disabled={!fallbackOnFailure}
            onChange={(event) =>
              setFallbackProvider((event.target.value || null) as ProviderId | null)
            }
          >
            <option value="">Tanpa cadangan</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {PROVIDER_NAME[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pt-4 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 min-h-0 min-w-0 flex-none rounded border-border accent-primary"
            aria-label={`Aktifkan cadangan ${label}`}
            checked={fallbackOnFailure}
            onChange={(event) => setFallbackOnFailure(event.target.checked)}
          />
          Aktifkan cadangan
        </label>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-sm font-medium text-foreground disabled:opacity-50"
          onClick={submit}
          disabled={!supported || fallbackMissing || saving}
        >
          Simpan {label}
        </button>
        {saved ? <span className="text-xs text-muted-foreground">Tersimpan</span> : null}
        {warning ? <span className="text-xs text-warning">{warning}</span> : null}
      </div>
    </div>
  );
}

export function ProviderSettingsForm(props: {
  rows: ProviderSettingRow[];
  onSave: (draft: ProviderSettingDraft) => Promise<{ ok: boolean; error?: string }>;
}) {
  return (
    <div className="space-y-3">
      {props.rows.map((row) => (
        <ProviderRow key={row.target} row={row} onSave={props.onSave} />
      ))}
    </div>
  );
}
