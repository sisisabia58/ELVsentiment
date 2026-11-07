"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { LogoutForm } from "@/components/logout-form";
import { generateCandidates } from "@/domain/variants";
import { ONBOARDING_BRAND_HINT, ONBOARDING_SCHEDULE_HINT } from "@/monitor/copy";
import {
  ALL_SOURCES,
  SOURCE_NAME,
  listedKeywords,
  workingSources,
  type OnboardingDraft,
  type OnboardingDraftFields,
  type SourceCredentials,
  type SourceId,
} from "@/monitor/onboarding-draft";
import type { ScheduleChoice } from "@/monitor/schedule-choice";
import { choiceLabel } from "@/monitor/schedule-choice";
import { clearOnboardingDraftAction, saveOnboardingDraftAction } from "@/app/onboarding/draft-actions";
import { saveProjectSettingsAction } from "@/app/proyek/actions";
import { createProjectForSession } from "@/app/onboarding/page-actions";
import { Wordmark } from "./bits";
import { ScheduleFields } from "./schedule-fields";
import { SourceChoices } from "./source-choices";

const LABELS = ["Merek", "Variasi", "Sumber", "Jadwal", "Mulai"];

type Existing = {
  projectId: string;
  brandName: string;
  keywords: string[];
  sources: SourceId[];
  schedule: ScheduleChoice;
};

export function OnboardingWizard(props: {
  existing: Existing | null;
  credentials: SourceCredentials;
  initial?: Pick<OnboardingDraft, "step" | "brand" | "keywords" | "sources" | "schedule">;
  onRun: (projectId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [step, setStep] = useState(props.initial?.step ?? 1);
  const [brand, setBrand] = useState(props.initial?.brand ?? props.existing?.brandName ?? "");
  const [keywords, setKeywords] = useState<string[]>(
    props.initial?.keywords ??
      (props.existing?.keywords.length ? props.existing.keywords : props.existing ? [props.existing.brandName] : []),
  );
  const [draftKeyword, setDraftKeyword] = useState("");
  const [sources, setSources] = useState<SourceId[]>(
    workingSources(props.initial?.sources ?? props.existing?.sources ?? ALL_SOURCES, props.credentials),
  );
  const [schedule, setSchedule] = useState<ScheduleChoice>(
    props.initial?.schedule ?? props.existing?.schedule ?? { mode: "off", intervalHours: 6 },
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const advancing = useRef(false);
  const finished = useRef(false);
  const saveEpoch = useRef(0);
  const writeChain = useRef(Promise.resolve());
  const heldWrite = useRef<{ epoch: number; key: string } | null>(null);

  const candidates = generateCandidates(brand);
  const visibleKeywords = listedKeywords(candidates, keywords);
  const availableSources = ALL_SOURCES.filter((source) => Boolean(props.credentials[source]));
  const canNext =
    step === 1 ? brand.trim().length > 0 : step === 2 ? keywords.length > 0 : step === 3 ? availableSources.length === 0 || sources.length > 0 : true;

  function enqueueDraft(fields: OnboardingDraftFields, epoch: number): Promise<void> {
    const run = writeChain.current
      .then(async () => {
        if (finished.current || epoch !== saveEpoch.current) return;
        await saveOnboardingDraftAction(fields);
        if (epoch !== saveEpoch.current) return;
        if (finished.current) await clearOnboardingDraftAction();
      })
      .catch(() => undefined);
    writeChain.current = run;
    return run;
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("langkah", String(step));
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    if (finished.current) return;
    const fields: OnboardingDraftFields = {
      projectId: props.existing?.projectId ?? null,
      step,
      brand,
      keywords,
      sources,
      schedule,
    };
    if (heldWrite.current?.epoch === saveEpoch.current && heldWrite.current.key === JSON.stringify(fields)) return;
    const epoch = ++saveEpoch.current;
    heldWrite.current = null;
    const timer = window.setTimeout(() => {
      enqueueDraft(fields, epoch);
    }, 200);
    const flush = () => {
      window.clearTimeout(timer);
      enqueueDraft(fields, epoch);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [brand, keywords, props.existing?.projectId, schedule, sources, step]);

  async function lanjut() {
    if (advancing.current || !canNext) return;
    advancing.current = true;
    setBusy(true);
    let nextKeywords = keywords;
    if (step === 1 && nextKeywords.length === 0 && brand.trim()) {
      const seeded = generateCandidates(brand);
      if (seeded[0]) nextKeywords = [seeded[0]];
    }
    const nextStep = step + 1;
    const fields: OnboardingDraftFields = {
      projectId: props.existing?.projectId ?? null,
      step: nextStep,
      brand,
      keywords: nextKeywords,
      sources,
      schedule,
    };
    // Drop a draft write that was queued for the step we are leaving, and
    // keep this write on the same chain as later edits and Kembali.
    const epoch = ++saveEpoch.current;
    heldWrite.current = { epoch, key: JSON.stringify(fields) };
    if (nextKeywords !== keywords) setKeywords(nextKeywords);
    setStep(nextStep);
    try {
      await enqueueDraft(fields, epoch);
    } finally {
      advancing.current = false;
      setBusy(false);
    }
  }

  async function finish(run: boolean) {
    setError(null);
    setPending(true);
    const created = props.existing ?? (await createProjectForSession(brand.trim()));
    if (!created) {
      setPending(false);
      setError("Masukkan nama merek.");
      return;
    }
    const saved = await saveProjectSettingsAction({
      projectId: created.projectId,
      brandName: brand.trim(),
      variants: keywords,
      sources: workingSources(sources, props.credentials),
      schedule,
    });
    if (!saved.ok) {
      setPending(false);
      setError(saved.error);
      return;
    }
    const sourcesReady = sources.some((source) => props.credentials[source]);
    if (run && !sourcesReady) {
      setPending(false);
      setError("Sumber yang dipilih sedang tidak tersedia, kami sedang memperbaikinya.");
      return;
    }
    if (run) {
      setRunning(true);
      const started = await props.onRun(created.projectId);
      if (!started.ok) {
        setPending(false);
        setRunning(false);
        setError(started.error ?? "Sumber yang dipilih sedang tidak tersedia, kami sedang memperbaikinya.");
        return;
      }
    }
    finished.current = true;
    saveEpoch.current += 1;
    writeChain.current = writeChain.current.then(() => clearOnboardingDraftAction()).catch(() => undefined);
    await writeChain.current;
    router.push(`/dasbor?proyek=${created.projectId}`);
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 pb-32 pt-8 sm:px-6 sm:pt-10">
        <div className="flex items-center justify-between">
          <Wordmark />
          <LogoutForm />
        </div>
        <p className="mt-6 text-sm text-muted-foreground lg:hidden">
          Langkah {step} dari {LABELS.length}: {LABELS[step - 1]}
        </p>
        <div className="mx-auto mt-6 hidden max-w-xl items-start lg:flex" role="group" aria-label="Langkah onboarding">
          {LABELS.map((label, index) => {
            const number = index + 1;
            const completed = number < step;
            const current = number === step;
            return (
              <div key={label} className="flex flex-1 items-start">
                {index > 0 ? <div aria-hidden="true" className={`mt-4 h-0.5 flex-1 ${number <= step ? "bg-primary" : "bg-border"}`} /> : null}
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    disabled={!completed || busy}
                    onClick={() => completed && !busy && setStep(number)}
                    aria-current={current ? "step" : undefined}
                    aria-label={`Langkah ${number}: ${label}`}
                    className={`grid size-8 place-items-center rounded-full border text-[13px] font-semibold ${completed ? "border-primary bg-primary text-primary-foreground" : current ? "border-primary bg-surface text-primary" : "border-border bg-surface text-muted-foreground"}`}
                  >
                    {completed ? <Check className="size-4" aria-hidden="true" /> : number}
                  </button>
                  <span className={`text-xs font-medium ${current ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mx-auto mt-6 w-full max-w-[560px] rounded-[14px] border border-border bg-surface p-6 shadow-card sm:mt-8 sm:p-8">
          {step === 1 ? (
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Merek apa yang ingin Anda pantau?</h1>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Nama ini menjadi dasar kami mencari sebutan di X dan Threads.</p>
              <label htmlFor="onboarding-brand" className="mb-1.5 mt-6 block text-[13px] font-medium">
                Nama merek
              </label>
              <input
                id="onboarding-brand"
                value={brand}
                onChange={(event) => {
                  setBrand(event.target.value);
                  if (!props.existing) setKeywords([]);
                }}
                placeholder="Nama merek Anda"
                className="h-11 w-full rounded-lg border border-input-border bg-surface px-3 text-sm"
              />
              <p className="mt-2 text-xs text-muted-foreground">{ONBOARDING_BRAND_HINT}</p>
            </div>
          ) : null}
          {step === 2 ? (
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Variasi kata kunci</h1>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Kata kunci membantu mencari calon sebutan. Sistem memeriksa apakah setiap postingan benar-benar terkait merek Anda.
              </p>
              <ul className="mt-4 space-y-2">
                {visibleKeywords.map((candidate) => (
                  <li key={candidate}>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={keywords.includes(candidate)}
                        onChange={() =>
                          setKeywords((current) =>
                            current.includes(candidate) ? current.filter((item) => item !== candidate) : [...current, candidate],
                          )
                        }
                      />
                      {candidate}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex min-w-0 max-w-full gap-2">
                <input
                  aria-label="Variasi kata kunci"
                  value={draftKeyword}
                  onChange={(event) => setDraftKeyword(event.target.value)}
                  className="h-11 w-0 min-w-0 flex-1 rounded-lg border border-input-border px-3 text-sm"
                />
                <button
                  type="button"
                  className="h-11 shrink-0 rounded-lg border border-border px-3 text-sm font-medium"
                  onClick={() => {
                    const value = draftKeyword.trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
                    if (!value || keywords.includes(value)) return;
                    setKeywords((current) => [...current, value]);
                    setDraftKeyword("");
                  }}
                >
                  Tambahkan
                </button>
              </div>
            </div>
          ) : null}
          {step === 3 ? (
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Sumber</h1>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Akses sumber dikelola oleh kami. Anda tidak perlu menghubungkan akun.</p>
              <div className="mt-3">
                <SourceChoices credentials={props.credentials} selected={sources} onChange={setSources} />
              </div>
            </div>
          ) : null}
          {step === 4 ? (
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Jadwal pengumpulan</h1>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{ONBOARDING_SCHEDULE_HINT}</p>
              <div className="mt-4">
                <ScheduleFields value={schedule} onChange={setSchedule} />
              </div>
            </div>
          ) : null}
          {step === 5 ? (
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Siap memulai</h1>
              <dl className="mt-4 space-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Merek</dt>
                  <dd>{brand.trim()}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Variasi</dt>
                  <dd>{keywords.join(", ")}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Sumber</dt>
                  <dd>{sources.map((s) => SOURCE_NAME[s]).join(", ")}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Jadwal</dt>
                  <dd>{choiceLabel(schedule)}</dd>
                </div>
              </dl>
              {running ? <p className="mt-4 text-sm">Permintaan pengumpulan dikirim. Anda bisa menutup halaman ini.</p> : null}
              {error ? (
                <p role="alert" className="mt-4 text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="mt-6 flex flex-col gap-2">
                {sources.some((source) => props.credentials[source]) ? (
                  <button type="button" disabled={pending} onClick={() => void finish(true)} className="h-11 rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:opacity-50">
                    Jalankan sekarang
                  </button>
                ) : (
                  <p className="text-sm text-muted-foreground">Sumber yang dipilih sedang tidak tersedia, kami sedang memperbaikinya.</p>
                )}
                <button type="button" disabled={pending} onClick={() => void finish(false)} className="h-11 rounded-lg border border-border text-sm font-medium">
                  {sources.some((source) => props.credentials[source]) ? "Lewati dulu, ke dasbor" : "Simpan dan buka dasbor"}
                </button>
              </div>
            </div>
          ) : null}
          {step < 5 ? (
            <div className="mt-8 flex items-center justify-between">
              {step > 1 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStep((current) => current - 1)}
                  className="h-11 px-3 text-sm font-medium text-primary disabled:opacity-50"
                >
                  Kembali
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                disabled={!canNext || busy}
                aria-busy={busy}
                onClick={() => {
                  void lanjut();
                }}
                className="inline-flex h-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                Lanjut
              </button>
            </div>
          ) : null}
        </div>
        <p className="mx-auto mt-4 max-w-[560px] text-center text-xs text-muted-foreground">
          Sudah punya proyek? <Link href="/proyek" className="font-medium text-primary">Lihat proyek</Link>
        </p>
      </div>
    </main>
  );
}
