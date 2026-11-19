"use client";

import { useState } from "react";
import { MessageSquareText } from "lucide-react";
import { cn } from "cn";
import { formatRelative } from "@/monitor/format";
import { SORT_LABEL, type SortMode } from "@/monitor/search/filters";
import type { SnapshotComment, SnapshotResult } from "@/monitor/search/load";
import { supportedProviders } from "@/monitor/search/platforms";
import { PLATFORM_ORDER, PlatformTile, platformName } from "./platform-tile";

const compact = new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 });

export function formatCompact(value: number): string {
  return compact.format(value).replace(/\u00a0/g, " ");
}

function commentsCollected(platform: string): boolean {
  return supportedProviders(platform, "comments").length > 0;
}

// Spaces and zero-width/object-replacement characters still look blank.
const INVISIBLE_COMMENT_CHAR =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFFC]/g;

function commentTextIsVisible(value: string): boolean {
  return value.replace(INVISIBLE_COMMENT_CHAR, "").trim().length > 0;
}

function visibleComments(comments: SnapshotComment[], replyCount: number | null): SnapshotComment[] {
  const withText = comments.filter((comment) => commentTextIsVisible(comment.text));
  const cap = replyCount != null && replyCount >= 0 ? Math.min(3, replyCount) : 3;
  return withText.slice(0, cap);
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
          <span aria-hidden="true">♥</span>
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

function ResultCard(props: {
  result: SnapshotResult;
  comments: SnapshotComment[];
  now: Date;
  showPlatform: boolean;
}) {
  const result = props.result;
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const comments = visibleComments(props.comments, result.replies);
  function checkThumbnail(image: HTMLImageElement | null) {
    if (image?.complete && image.naturalWidth === 0) setThumbnailFailed(true);
  }
  const remaining = result.replies == null ? 0 : Math.max(0, result.replies - comments.length);
  const heading = result.title?.trim() || result.text.trim() || "Tanpa teks";
  const handle = result.authorHandle?.trim() || result.authorName?.trim() || "";
  return (
    <article id={`hasil-${result.id}`} className="border-b border-border pb-4 last:border-b-0 last:pb-0">
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-4 break-words text-[14.5px] font-semibold leading-6 text-foreground">
            {heading}
          </h3>
          {result.title && result.text && result.text !== result.title ? (
            <p className="mt-1 line-clamp-4 break-words text-[13px] leading-5 text-muted-foreground">
              {result.text}
            </p>
          ) : null}
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            {props.showPlatform ? <span>{platformName(result.platform)}</span> : null}
            {handle ? (
              <span className="min-w-0 max-w-full break-all font-mono text-foreground">
                {handle.startsWith("@") ? handle : `@${handle}`}
              </span>
            ) : null}
            <Engagement result={result} />
            <span>{result.publishedAt ? formatRelative(result.publishedAt, props.now) : "Tanggal tidak diketahui"}</span>
          </div>
        </div>
        <div className="relative h-[86px] w-[86px] shrink-0 overflow-hidden rounded-lg bg-surface-subtle sm:h-[96px] sm:w-[96px]">
          {result.thumbnailUrl && !thumbnailFailed ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={checkThumbnail}
                src={result.thumbnailUrl}
                alt="Pratinjau hasil"
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
                onError={() => setThumbnailFailed(true)}
              />
              <span className="absolute bottom-1 right-1">
                <PlatformTile platform={result.platform} size={16} />
              </span>
            </>
          ) : (
            <div
              data-testid="thumb-placeholder"
              aria-hidden="true"
              className="grid h-full w-full place-items-center"
            >
              <PlatformTile platform={result.platform} size={30} />
            </div>
          )}
        </div>
      </div>
      {comments.length > 0 ? (
        <div
          className="mt-3 rounded-lg border border-border bg-surface-subtle/60"
          aria-label="Contoh balasan teratas, bukan semua komentar"
        >
          <p className="flex items-center gap-1.5 px-3 pt-2.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
            <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
            BALASAN TERATAS
            <span className="rounded bg-border px-1 text-foreground">{comments.length + remaining}</span>
          </p>
          {comments.map((comment) => (
            <div key={comment.id} className="flex gap-3 border-b border-border/70 px-3 py-2 last:border-b-0">
              <span className="w-9 shrink-0 text-[12px] font-semibold tabular-nums text-positif">
                ▲ {comment.likes ?? 0}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] text-foreground">{comment.text}</p>
                {comment.authorHandle || comment.authorName ? (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {comment.authorHandle ?? comment.authorName}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
          {remaining > 0 ? (
            <p className="px-3 pb-2.5 pt-1 text-[12px] font-medium text-primary">{remaining} balasan lainnya</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ResultsList(props: {
  results: SnapshotResult[];
  commentsByResult: Record<string, SnapshotComment[]>;
  sortMode: SortMode;
  now?: Date;
}) {
  const [platform, setPlatform] = useState<string | null>(null);
  const now = props.now ?? new Date();
  if (props.results.length === 0) return null;
  const groups = PLATFORM_ORDER.map((key) => ({
    key,
    rows: props.results.filter((result) => result.platform === key),
  })).filter((group) => group.rows.length > 0);
  const selected = groups.find((group) => group.key === platform);
  const visible = selected?.rows ?? props.results;

  return (
    <section className="rounded-[14px] border border-border bg-surface shadow-card">
      <header className="flex items-center justify-between px-5 pt-4">
        <h2 className="text-[15px] font-semibold text-foreground">Hasil</h2>
        <span className="text-[12px] text-muted-foreground">{SORT_LABEL[props.sortMode]}</span>
      </header>
      <div className="flex flex-wrap gap-1.5 px-5 pt-3">
        <button
          type="button"
          onClick={() => setPlatform(null)}
          className={cn(
            "rounded-full px-3 py-1 text-[12.5px] font-medium",
            platform === null ? "bg-foreground text-background" : "border border-border hover:bg-surface-subtle",
          )}
        >
          Semua {props.results.length}
        </button>
        {groups.map((group) => (
          <button
            key={group.key}
            type="button"
            onClick={() => setPlatform(group.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium",
              platform === group.key ? "bg-foreground text-background" : "border border-border hover:bg-surface-subtle",
            )}
          >
            <PlatformTile platform={group.key} size={14} />
            {platformName(group.key)} {group.rows.length}
          </button>
        ))}
      </div>
      <div className="mt-3 px-5 py-4">
        {selected ? (
          <div className="mb-3 flex items-center gap-2.5">
            <PlatformTile platform={selected.key} size={26} />
            <div>
              <p className="text-[14px] font-semibold text-foreground">{platformName(selected.key)}</p>
              <p className="text-[12px] text-muted-foreground">{selected.rows.length} hasil</p>
            </div>
          </div>
        ) : null}
        <div className="space-y-4">
          {visible.map((result) => (
            <ResultCard
              key={result.id}
              result={result}
              comments={props.commentsByResult[result.id] ?? []}
              now={now}
              showPlatform={!selected}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
