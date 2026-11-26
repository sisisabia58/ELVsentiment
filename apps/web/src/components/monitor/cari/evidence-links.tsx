"use client";

import type { MouseEvent, ReactNode } from "react";
import { type EvidenceSource, sourceLabel, sourceLinkProps } from "./quote-source";

export const CARI_CITATION_EVENT = "cari-citation";

export function EvidenceLink({ source, className, children }: {
  source: EvidenceSource;
  className: string;
  children: ReactNode;
}) {
  function followCitation(event: MouseEvent<HTMLAnchorElement>) {
    if (!source.href.startsWith("#") || event.defaultPrevented ||
        event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (window.location.hash !== source.href) window.history.pushState(null, "", source.href);
    window.dispatchEvent(new CustomEvent(CARI_CITATION_EVENT, { detail: event.currentTarget }));
  }

  return <a {...sourceLinkProps(source)} className={className} onClick={followCitation}>{children}</a>;
}

export function EvidenceLinks({ sources, label = "Sumber" }: { sources: EvidenceSource[]; label?: string }) {
  if (!sources.length) return null;
  return (
    <ul aria-label={label} className="mt-2 flex flex-wrap gap-2">
      {sources.map((source) => (
        <li key={source.id} className="min-w-0 max-w-full">
          <EvidenceLink
            source={source}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-full bg-surface-subtle px-3 py-1.5 text-xs wrap-anywhere text-primary hover:underline"
          >
            {sourceLabel(source)}
          </EvidenceLink>
        </li>
      ))}
    </ul>
  );
}
