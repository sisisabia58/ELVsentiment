import { type EvidenceSource, sourceLabel, sourceLinkProps } from "./quote-source";

export function EvidenceLinks({ sources, label = "Sumber" }: { sources: EvidenceSource[]; label?: string }) {
  if (!sources.length) return null;
  return (
    <ul aria-label={label} className="mt-2 flex flex-wrap gap-2">
      {sources.map((source) => (
        <li key={source.id}>
          <a
            {...sourceLinkProps(source)}
            className="block rounded-full bg-surface-subtle px-2.5 py-1 text-[11.5px] text-primary hover:underline"
          >
            {sourceLabel(source)}
          </a>
        </li>
      ))}
    </ul>
  );
}
