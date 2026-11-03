"use client";

import { useState } from "react";
import { saveProfileAction } from "@/app/akun/actions";
import { Button } from "@/components/ui/button";

export function ProfileForm(props: { name: string; email: string }) {
  const [name, setName] = useState(props.name);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-4 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setMessage(null);
        void saveProfileAction(name)
          .then((result) => {
            if (!result.ok) setError(result.error);
            else setMessage(result.message);
          })
          .catch(() => setError("Perubahan belum tersimpan. Coba lagi."))
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Nama
        <input
          name="nama"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          className="h-11 rounded-lg border border-input-border bg-surface px-3"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input name="email" value={props.email} readOnly className="h-11 rounded-lg border border-border bg-surface-subtle px-3 text-muted-foreground" />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-success">
          {message}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="h-11 w-fit bg-primary text-primary-foreground">
        Simpan perubahan
      </Button>
    </form>
  );
}
