"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ERRORS = {
  empty: "Varian tidak boleh kosong.",
  duplicate: "Varian ini sudah ada.",
  too_long: "Varian terlalu panjang untuk pencarian X.",
} as const;

export function VariantEditor(props: {
  brandName: string;
  candidates: string[];
  selected: string[];
  error: "empty" | "duplicate" | "too_long" | null;
  onToggle: (variant: string) => void;
  onAdd: (variant: string) => void;
  onSave: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Siapkan pemantauan</h1>
      <p>{props.brandName}</p>
      <p>Kata kunci membantu mencari calon sebutan. Sistem memeriksa apakah setiap postingan benar-benar terkait merek Anda.</p>
      <ul className="flex flex-col gap-2">
        {props.candidates.map((candidate) => (
          <li key={candidate}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={props.selected.includes(candidate)}
                onChange={() => props.onToggle(candidate)}
              />
              <span>{candidate}</span>
            </label>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          props.onAdd(String(data.get("variant") ?? ""));
        }}
      >
        <Label htmlFor="variant">Tambah varian</Label>
        <Input id="variant" name="variant" />
        <Button type="submit">Tambah</Button>
      </form>
      {props.error ? <p role="alert">{ERRORS[props.error]}</p> : null}
      <Button type="button" onClick={props.onSave}>Simpan</Button>
    </section>
  );
}
