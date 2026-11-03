"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Eye, Gauge, ShieldCheck } from "lucide-react";
import type { AuthFormState } from "@/components/auth-form";
import { isLockoutMessage, LOCKOUT_CLIENT_CLOCK_REFRESH_MS, lockoutRefreshPlan, visibleAuthBanner } from "@/auth/lockout-banner";
import { Wordmark } from "./bits";

const BENEFITS = [
  { icon: Eye, text: "Pantau sebutan merek Anda di X dan Threads dari satu dasbor." },
  { icon: Gauge, text: "Penilaian otomatis memilah sentimen positif, netral, dan negatif." },
  { icon: ShieldCheck, text: "Akses sumber dikelola oleh kami. Anda tidak perlu menghubungkan akun." },
];

export function AuthScreen(props: {
  title: string;
  lede: string;
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  submitLabel: string;
  alternateHref: string;
  alternatePrompt: string;
  alternateLabel: string;
  mode: "sign-in" | "sign-up";
  lockExpiresAt?: string | null;
  lockMessage?: string | null;
}) {
  const router = useRouter();
  const refreshRoute = router.refresh;
  const [state, formAction, pending] = useActionState<AuthFormState & { attemptId: number }, FormData>(
    async (previous, formData) => {
      const result = await props.action(previous, formData);
      return { ...result, attemptId: previous.attemptId + 1 };
    },
    { error: null, attemptId: 0 },
  );
  const [dismissedAttempt, setDismissedAttempt] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const attemptId = state.attemptId;
  const error = isLockoutMessage(state.error) && attemptId === dismissedAttempt ? null : state.error;
  const banner = visibleAuthBanner({
    error,
    lockMessage: props.lockMessage,
    actionLockExpiresAt: state.lockExpiresAt,
    serverLockExpiresAt: props.lockExpiresAt,
  });
  useEffect(() => {
    const actionExpires = isLockoutMessage(state.error) && attemptId !== dismissedAttempt ? state.lockExpiresAt : null;
    const expiresAt = actionExpires || props.lockExpiresAt;
    if (!expiresAt || !banner) return;
    let timer = 0;
    let cancelled = false;
    const arm = (fromTimer: boolean) => {
      if (cancelled) return;
      const plan = lockoutRefreshPlan(expiresAt, Date.now());
      if (!plan) return;
      if (plan.action === "wait") {
        timer = window.setTimeout(() => arm(true), plan.ms);
        return;
      }
      if (!fromTimer) {
        timer = window.setTimeout(() => arm(true), LOCKOUT_CLIENT_CLOCK_REFRESH_MS);
        return;
      }
      setDismissedAttempt(attemptId);
      setRefreshNonce((value) => value + 1);
      refreshRoute();
    };
    arm(false);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [attemptId, banner, dismissedAttempt, props.lockExpiresAt, refreshNonce, refreshRoute, state.error, state.lockExpiresAt]);
  const passwordAutoComplete = props.mode === "sign-up" ? "new-password" : "current-password";
  return (
    <main className="min-h-screen bg-background lg:grid lg:grid-cols-2 lg:bg-surface">
      <div className="hidden bg-info-bg lg:flex lg:flex-col lg:justify-center lg:px-12 lg:py-16">
        <Wordmark />
        <h2 className="mt-8 max-w-sm text-[28px] font-semibold leading-tight tracking-tight text-foreground">
          Pantau percakapan tentang merek Anda.
        </h2>
        <ul className="mt-8 max-w-sm space-y-4">
          {BENEFITS.map((benefit) => (
            <li key={benefit.text} className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-primary shadow-card">
                <benefit.icon className="size-4" aria-hidden="true" />
              </span>
              <span className="text-sm leading-6 text-foreground">{benefit.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-h-screen flex-col items-center px-4 pb-16 pt-10 lg:justify-center lg:px-6 lg:py-16">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <div className="mt-8 w-full max-w-[400px] lg:mt-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{props.title}</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{props.lede}</p>
          <form className="mt-6 space-y-4" action={formAction} noValidate>
            {banner ? (
              <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger-bg px-3.5 py-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <p className="text-[13px] font-medium text-danger">{banner}</p>
              </div>
            ) : null}
            {props.mode === "sign-up" ? <Field id="name" name="name" label="Nama" type="text" autoComplete="name" placeholder="Nama Anda" /> : null}
            <Field id="email" name="email" label="Email" type="email" autoComplete="email" placeholder="nama@merekanda.id" />
            <Field
              id="password"
              name="password"
              label="Kata sandi"
              type="password"
              autoComplete={passwordAutoComplete}
              placeholder="Masukkan kata sandi"
            />
            {props.mode === "sign-up" ? (
              <Field
                id="confirm"
                name="confirm"
                label="Konfirmasi kata sandi"
                type="password"
                autoComplete="new-password"
                placeholder="Ulangi kata sandi"
              />
            ) : null}
            <button type="submit" disabled={pending} className="h-11 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:opacity-50">
              {props.submitLabel}
            </button>
          </form>
          <p className="mt-6 text-center text-[13px] text-muted-foreground">
            {props.alternatePrompt}{" "}
            <Link href={props.alternateHref} className="font-medium text-primary">
              {props.alternateLabel}
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}

function Field(props: {
  id: string;
  name: string;
  label: string;
  type: string;
  autoComplete: string;
  placeholder: string;
}) {
  return (
    <div>
      <label htmlFor={props.id} className="mb-1.5 block text-[13px] font-medium text-foreground">
        {props.label}
      </label>
      <input
        id={props.id}
        name={props.name}
        type={props.type}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        required
        className="h-11 w-full rounded-lg border border-input-border bg-surface px-3 text-sm text-foreground"
      />
    </div>
  );
}
