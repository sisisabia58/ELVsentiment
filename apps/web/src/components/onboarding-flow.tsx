"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VariantEditor } from "@/components/variant-editor";

type CreatedProject = { projectId: string; brandName: string; candidates: string[] };
type SaveResult =
  | { ok: true; active: string[] }
  | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string };

export function OnboardingFlow(props: {
  createProject: (brandName: string) => Promise<CreatedProject | null>;
  saveVariants: (projectId: string, variants: string[]) => Promise<SaveResult>;
  existing?: CreatedProject & { selected: string[] };
}) {
  const [project, setProject] = useState<CreatedProject | null>(props.existing ?? null);
  const [candidates, setCandidates] = useState<string[]>(props.existing?.candidates ?? []);
  const [selected, setSelected] = useState<string[]>(props.existing?.selected ?? []);
  const [error, setError] = useState<"empty" | "duplicate" | "too_long" | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!project) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const brandName = String(new FormData(event.currentTarget).get("brandName") ?? "");
          startTransition(async () => {
            const created = await props.createProject(brandName);
            if (!created) return;
            setProject(created);
            setCandidates(created.candidates);
          });
        }}
      >
        <Label htmlFor="brandName">Nama merek</Label>
        <Input id="brandName" name="brandName" required />
        <Button type="submit" disabled={pending}>
          Buat proyek
        </Button>
      </form>
    );
  }

  return (
    <>
      <VariantEditor
        brandName={project.brandName}
        candidates={candidates}
        selected={selected}
        error={error}
        onToggle={(variant) => {
          setSaved(false);
          setSelected((current) =>
            current.includes(variant) ? current.filter((item) => item !== variant) : [...current, variant],
          );
        }}
        onAdd={(variant) => {
          setSaved(false);
          setSelected((current) => [...current, variant]);
          if (variant.trim() && !candidates.includes(variant)) setCandidates((current) => [...current, variant]);
        }}
        onSave={() => {
          startTransition(async () => {
            const result = await props.saveVariants(project.projectId, selected);
            setError(result.ok ? null : result.reason);
            setSaved(result.ok);
          });
        }}
      />
      {saved ? (
        <div className="flex flex-col gap-2">
          <p>Varian aktif disimpan.</p>
          <Link href="/dasbor">Ke dasbor</Link>
        </div>
      ) : null}
    </>
  );
}
