"use client";

import {
  ALL_SOURCES,
  SOURCE_NAME,
  workingSources,
  type SourceCredentials,
  type SourceId,
} from "@/monitor/onboarding-draft";

export function SourceChoices(props: {
  credentials: SourceCredentials;
  selected: SourceId[];
  onChange: (next: SourceId[]) => void;
}) {
  return (
    <>
      {ALL_SOURCES.map((source) => {
        const available = Boolean(props.credentials[source]);
        const label = SOURCE_NAME[source];
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
            {available ? null : (
              <span>{`Sumber ${label} sedang tidak tersedia, kami sedang memperbaikinya.`}</span>
            )}
          </label>
        );
      })}
    </>
  );
}
