"use client";

import { Component, createRef, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, Heart, ListChecks, MessageSquareText } from "lucide-react";
import { cn } from "cn";
import { formatRelative } from "@/monitor/format";
import { isNativePantauResult } from "@/monitor/search/feature";
import { SORT_LABEL, type SortMode } from "@/monitor/search/filters";
import type { SnapshotComment, SnapshotResult, SnapshotSource } from "@/monitor/search/load";
import { supportedProviders } from "@/monitor/search/platforms";
import { originalPostHref } from "@/monitor/search/post-permalink";
import { CARI_CITATION_EVENT, type CariCitationOrigin } from "./evidence-links";
import { commentTextIsVisible } from "./quote-source";
import { MoreSourceControl, type MoreSourceActions } from "./more-source-control";
import { PLATFORM_ORDER, PlatformTile, platformName } from "./platform-tile";

const compact = new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 });

export function formatCompact(value: number): string {
  return compact.format(value).replace(/\u00a0/g, " ");
}

function commentsCollected(platform: string): boolean {
  return supportedProviders(platform, "comments").length > 0;
}

function Engagement(props: { result: SnapshotResult }) {
  const result = props.result;
  const replies = result.replies;
  const collected = commentsCollected(result.platform);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
      {result.views != null ? (
        <span className="rounded-md bg-surface-subtle px-1.5 py-0.5">{formatCompact(result.views)} tayangan</span>
      ) : null}
      {result.likes != null ? (
        <span className="inline-flex items-center gap-1 rounded-md bg-surface-subtle px-1.5 py-0.5">
          <Heart className="size-3" aria-hidden="true" />
          <span className="sr-only">Suka: </span>
          <span>{formatCompact(result.likes)}</span>
        </span>
      ) : null}
      {collected && replies != null ? (
        <span className="rounded-md bg-surface-subtle px-1.5 py-0.5">{formatCompact(replies)} balasan</span>
      ) : null}
      {!collected && replies != null && replies > 0 ? (
        <span className="rounded-md bg-surface-subtle px-1.5 py-0.5">Balasan tidak diambil</span>
      ) : null}
      {result.shares != null ? (
        <span className="rounded-md bg-surface-subtle px-1.5 py-0.5">{formatCompact(result.shares)} bagikan</span>
      ) : null}
    </div>
  );
}

type ReviewResult = (resultId: string, trigger: HTMLButtonElement) => void;

type LocalCitation = { id: string; resultId: string; platform: string; reply: boolean };

function ResultCard(props: {
  result: SnapshotResult;
  comments: SnapshotComment[];
  now: Date;
  showPlatform: boolean;
  citation: LocalCitation | null;
  onReview?: ReviewResult;
}) {
  const result = props.result;
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState({ citation: props.citation, open: Boolean(props.citation) });
  if (props.citation && disclosure.citation !== props.citation) {
    setDisclosure({ citation: props.citation, open: true });
  }
  const repliesOpen = disclosure.open;
  const retained = props.comments.filter((comment) => commentTextIsVisible(comment.text));
  const comments = repliesOpen ? retained : retained.slice(0, 3);
  const hiddenRetained = Math.max(0, retained.length - 3);
  const uncollected = Math.max(0, (result.replies ?? 0) - props.comments.length);
  const replyTotal = Math.max(retained.length, result.replies ?? 0);
  const repliesId = `balasan-hasil-${result.id}`;
  const heading = result.title?.trim() || result.text.trim() || "Tanpa teks";
  const handle = result.authorHandle?.trim() || result.authorName?.trim() || "";
  const platform = platformName(result.platform);
  const href = originalPostHref(result.platform, result.url);
  const PostPreview = href ? "a" : "div";

  return (
    <article id={`hasil-${result.id}`} tabIndex={-1} className="min-w-0 px-3 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:px-5 sm:py-5">
      <PostPreview
        className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5 rounded-lg sm:gap-x-4",
          href && "group focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary")}
        {...(href ? {
          href,
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": `${heading} (buka unggahan asli di ${platform}, tab baru)`,
        } : {})}
      >
        <div className="min-w-0">
          <h3 className={cn(
            "line-clamp-4 wrap-anywhere text-base font-semibold leading-snug text-foreground",
            href && "group-hover:text-primary",
          )}>
            {heading}
          </h3>
          {result.title && result.text && result.text !== result.title ? (
            <p className="mt-1.5 line-clamp-3 wrap-anywhere text-sm leading-relaxed text-foreground/80">
              {result.text}
            </p>
          ) : null}
        </div>
        <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-surface-subtle sm:size-24">
          {result.thumbnailUrl && result.thumbnailUrl !== failedThumbnail ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={result.thumbnailUrl}
                ref={(image) => {
                  if (image?.complete && image.naturalWidth === 0) setFailedThumbnail(result.thumbnailUrl);
                }}
                src={result.thumbnailUrl}
                alt="Pratinjau hasil"
                loading="lazy"
                referrerPolicy="no-referrer"
                className="size-full object-cover"
                onError={() => setFailedThumbnail(result.thumbnailUrl)}
              />
              <span className="absolute bottom-1 right-1">
                <PlatformTile platform={result.platform} size={16} />
              </span>
            </>
          ) : (
            <div data-testid="thumb-placeholder" aria-hidden="true" className="grid size-full place-items-center">
              <PlatformTile platform={result.platform} size={26} />
            </div>
          )}
        </div>
        <div className="col-span-full flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {props.showPlatform ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
              <PlatformTile platform={result.platform} size={14} />
              {platform}
            </span>
          ) : null}
          {handle ? (
            <span className="min-w-0 max-w-full wrap-anywhere font-medium">
              {handle.startsWith("@") ? handle : `@${handle}`}
            </span>
          ) : null}
          {result.publishedAt ? (
            <time dateTime={result.publishedAt}>{formatRelative(result.publishedAt, props.now)}</time>
          ) : <span>Tanggal tidak diketahui</span>}
        </div>
        <div className="col-span-full flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Engagement result={result} />
          {href ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary group-hover:underline">
              Buka di {platform}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </span>
          ) : null}
        </div>
      </PostPreview>
      {props.onReview && isNativePantauResult(result.platform, result.externalId, result.webIndex) ? (
        <button
          type="button"
          aria-haspopup="dialog"
          className="workspace-feedback mt-2 inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-primary hover:bg-info-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          onClick={(event) => props.onReview?.(result.id, event.currentTarget)}
        >
          <ListChecks className="size-4" aria-hidden="true" />
          Tinjau
        </button>
      ) : null}
      {comments.length > 0 ? (
        <div className="mt-3 rounded-lg bg-surface-subtle/75" aria-label="Contoh balasan teratas, bukan semua komentar">
          <p className="flex items-center gap-1.5 px-3 pt-3 text-xs font-semibold text-muted-foreground">
            <MessageSquareText className="size-3.5" aria-hidden="true" />
            BALASAN TERATAS
            <span className="rounded bg-border px-1 tabular-nums text-foreground">{replyTotal}</span>
          </p>
          <div id={repliesId} className="divide-y divide-border/70">
            {comments.map((comment, index) => (
              <div key={comment.id} id={`balasan-${comment.id}`} tabIndex={-1}
                className={cn("flex gap-2.5 px-3 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary", index >= 3 && "cari-reveal")}>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-positif">▲ {comment.likes ?? 0}</span>
                <div className="min-w-0">
                  <p className="wrap-anywhere text-sm leading-snug text-foreground">{comment.text}</p>
                  {comment.authorHandle || comment.authorName ? (
                    <p className="mt-0.5 wrap-anywhere text-xs text-muted-foreground">
                      {comment.authorHandle ?? comment.authorName}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {hiddenRetained > 0 ? (
            <button type="button" aria-expanded={repliesOpen} aria-controls={repliesId}
              onClick={() => setDisclosure({ citation: props.citation, open: !repliesOpen })}
              className="workspace-feedback flex min-h-11 min-w-11 items-center gap-1.5 rounded-lg px-3 text-left text-xs font-semibold text-primary hover:bg-primary/5">
              {repliesOpen ? "Sembunyikan balasan tambahan" : `Lihat ${hiddenRetained} balasan tersimpan`}
              <ChevronDown className={cn("size-4 shrink-0", repliesOpen && "rotate-180")} aria-hidden="true" />
            </button>
          ) : null}
          {uncollected > 0 ? (
            <p className="px-3 pb-3 pt-1 text-xs text-muted-foreground">{uncollected} balasan lainnya belum diambil</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

type ResultFeedProps = {
  results: SnapshotResult[];
  platform: string | null;
  children: ReactNode;
};

type ScrollAnchor = { card: HTMLElement; top: number } | null;

// Read the old DOM immediately before React commits polling changes to the feed.
class ResultFeed extends Component<ResultFeedProps, object, ScrollAnchor> {
  private feed = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: ResultFeedProps): ScrollAnchor {
    if (previous.platform !== this.props.platform || previous.results === this.props.results) return null;
    const bounds = this.feed.current?.getBoundingClientRect();
    if (!bounds || bounds.top >= window.innerHeight || bounds.bottom <= 0) return null;
    const nextIds = new Set(this.props.results.map((result) => `hasil-${result.id}`));
    for (const child of this.feed.current?.children ?? []) {
      if (!(child instanceof HTMLElement) || !nextIds.has(child.id)) continue;
      const rect = child.getBoundingClientRect();
      const stickyClearance = parseFloat(getComputedStyle(child).scrollMarginTop) || 0;
      if (rect.bottom > stickyClearance && rect.top < window.innerHeight) return { card: child, top: rect.top };
    }
    return null;
  }

  componentDidUpdate(_previous: ResultFeedProps, _state: object, anchor?: ScrollAnchor) {
    if (!anchor) return;
    const delta = anchor.card.getBoundingClientRect().top - anchor.top;
    if (delta) window.scrollBy({ top: delta, behavior: "instant" });
  }

  render() {
    return <div ref={this.feed} className="divide-y divide-border [overflow-anchor:none]">{this.props.children}</div>;
  }
}

export function ResultsList(props: {
  results: SnapshotResult[];
  commentsByResult: Record<string, SnapshotComment[]>;
  sortMode: SortMode;
  sources?: SnapshotSource[];
  moreActions?: MoreSourceActions;
  onReview?: ReviewResult;
  now?: Date;
}) {
  const [platform, setPlatform] = useState<string | null>(null);
  const [citation, setCitation] = useState<LocalCitation | null>(null);
  const handledHash = useRef("");
  const returnLink = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    function revealLocalCitation(event?: Event) {
      const hash = window.location.hash;
      if (!event && hash === handledHash.current) return;
      if (event instanceof CustomEvent) {
        const origin = event.detail as CariCitationOrigin;
        if (!origin.previousHash) returnLink.current = origin.link;
      }

      if (!hash) {
        handledHash.current = "";
        setCitation(null);
        if (returnLink.current?.isConnected) returnLink.current.focus({ preventScroll: true });
        returnLink.current = null;
        return;
      }

      for (const result of props.results) {
        const post = hash === `#hasil-${result.id}`;
        const reply = hash.startsWith("#balasan-") && (props.commentsByResult[result.id] ?? []).some((comment) =>
          hash === `#balasan-${comment.id}` && comment.resultId === result.id &&
          comment.platform === result.platform && commentTextIsVisible(comment.text),
        );
        if (!post && !reply) continue;
        handledHash.current = hash;
        setCitation({ id: hash.slice(1), resultId: result.id, platform: result.platform, reply });
        setPlatform((selected) => reply || selected !== null ? result.platform : null);
        return;
      }

      setCitation(null);
    }

    revealLocalCitation();
    window.addEventListener("hashchange", revealLocalCitation);
    window.addEventListener(CARI_CITATION_EVENT, revealLocalCitation);
    return () => {
      window.removeEventListener("hashchange", revealLocalCitation);
      window.removeEventListener(CARI_CITATION_EVENT, revealLocalCitation);
    };
  }, [props.commentsByResult, props.results]);

  useEffect(() => {
    if (!citation) return;
    const target = document.getElementById(citation.id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "start" });
  }, [citation]);

  function selectPlatform(next: string | null) {
    if (citation && next && citation.platform !== next) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      handledHash.current = "";
      returnLink.current = null;
      setCitation(null);
    }
    setPlatform(next);
  }

  const now = props.now ?? new Date();
  if (props.results.length === 0) return null;
  const groups = PLATFORM_ORDER.map((key) => ({
    key,
    rows: props.results.filter((result) => result.platform === key),
  })).filter((group) => group.rows.length > 0);
  const selected = groups.find((group) => group.key === platform);
  const visible = selected?.rows ?? props.results;

  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface shadow-card">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 pt-4 sm:px-5">
        <h2 className="text-base font-semibold text-foreground">Hasil</h2>
        <span className="text-[12px] text-muted-foreground">{SORT_LABEL[props.sortMode]}</span>
      </header>
      <div className="flex flex-wrap gap-1.5 px-3 py-3 sm:px-5">
        <button
          type="button"
          aria-pressed={platform === null}
          onClick={() => selectPlatform(null)}
          className={cn(
            "workspace-feedback min-h-11 min-w-11 rounded-full border border-transparent px-3 text-xs font-medium",
            platform === null ? "bg-primary text-primary-foreground" : "border-border hover:bg-surface-subtle",
          )}
        >
          Semua {props.results.length}
        </button>
        {groups.map((group) => (
          <button
            key={group.key}
            type="button"
            aria-pressed={platform === group.key}
            onClick={() => selectPlatform(group.key)}
            className={cn(
              "workspace-feedback flex min-h-11 min-w-11 items-center gap-1.5 rounded-full border border-transparent px-3 text-xs font-medium",
              platform === group.key ? "bg-primary text-primary-foreground" : "border-border hover:bg-surface-subtle",
            )}
          >
            <PlatformTile platform={group.key} size={14} />
            {platformName(group.key)} {group.rows.length}
          </button>
        ))}
      </div>
      <div className="border-t border-border">
        {selected ? (
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2.5 border-b border-border bg-surface-subtle/60 px-3 py-2 sm:px-5">
            <div className="flex min-h-11 shrink-0 items-center gap-2.5">
              <PlatformTile platform={selected.key} size={26} />
              <div>
                <p className="text-sm font-semibold text-foreground">{platformName(selected.key)}</p>
                <p className="text-xs tabular-nums text-muted-foreground">{selected.rows.length} hasil</p>
              </div>
            </div>
            <MoreSourceControl
              platform={selected.key}
              more={props.sources?.find((source) => source.platform === selected.key)?.more}
              actions={props.moreActions}
            />
          </div>
        ) : null}
        <ResultFeed results={props.results} platform={platform}>
          {visible.map((result) => (
            <ResultCard
              key={result.id}
              result={result}
              comments={props.commentsByResult[result.id] ?? []}
              now={now}
              showPlatform={!selected}
              onReview={props.onReview}
              citation={citation?.reply && citation.resultId === result.id ? citation : null}
            />
          ))}
        </ResultFeed>
      </div>
    </section>
  );
}
