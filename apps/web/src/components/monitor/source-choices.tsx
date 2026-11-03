"use client";

import { workingSources, type SourceCredentials } from "@/monitor/onboarding-draft";

export function SourceChoices(props: {
  credentials: SourceCredentials;
  selected: ("x" | "threads")[];
  onChange: (next: ("x" | "threads")[]) => void;
}) {
  return (
    <>
      {(["x", "threads"] as const).map((source) => {
        const available = props.credentials[source];
        const label = source === "x" ? "X" : "Threads";
        return (
          <label key={source} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={available && props.selected.includes(source)}
              disabled={!available}
              onChange={() => {
                if (!available) return;
                props.onChange(
                  props.selected.includes(source)
                    ? workingSources(
                        props.selected.filter((item) => item !== source),
                        props.credentials,
                      )
                    : workingSources([...props.selected, source], props.credentials),
                );
              }}
            />
            <span>{label}</span>
            {available ? null : <span>Tidak tersedia</span>}
          </label>
        );
      })}
    </>
  );
}
