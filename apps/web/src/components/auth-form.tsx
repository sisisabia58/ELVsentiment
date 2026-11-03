"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AuthFormState = { error: string | null; lockExpiresAt?: string | null };

export function AuthForm(props: {
  title: string;
  submitLabel: string;
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  alternateHref: string;
  alternateLabel: string;
  passwordAutoComplete?: "current-password" | "new-password";
}) {
  const [state, formAction, pending] = useActionState(props.action, { error: null });
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">{props.title}</h1>
      <form action={formAction} className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
        <Label htmlFor="password">Kata sandi</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={props.passwordAutoComplete ?? "current-password"}
          required
        />
        {state.error ? <p role="alert">{state.error}</p> : null}
        <Button type="submit" disabled={pending}>
          {props.submitLabel}
        </Button>
      </form>
      <Link href={props.alternateHref}>{props.alternateLabel}</Link>
    </section>
  );
}
