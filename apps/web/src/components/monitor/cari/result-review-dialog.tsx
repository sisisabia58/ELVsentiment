"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ArrowUpRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  monitorAsProjectAction,
  readCariReviewAction,
  routeCariResultAction,
  undoCariRouteAction,
} from "@/app/cari/start-action";
import { MANUAL_ROUTE_LABEL, TRIAGE_REASON_LABEL, TRIAGE_STATUS_LABEL, type TriageJudgment } from "@/monitor/present";
import type { SnapshotResult } from "@/monitor/search/load";
import { originalPostHref } from "@/monitor/search/post-permalink";
import type { ReviewDestination } from "@/monitor/search/review-result";
import type { ReviewReadResult, ReviewWriteResult, RouteInput, UndoInput } from "@/monitor/search/review-routing";
import { ManualRouteTag } from "../bits";
import { PlatformTile, platformName } from "./platform-tile";

type ReviewError = Extract<ReviewReadResult, { ok: false }>["error"];
type Review = Extract<ReviewReadResult, { ok: true }>;
type Feedback = { tone: "error" | "status"; text: string };

const ERROR_LABEL: Record<ReviewError, string> = {
  unauthenticated: "Sesi Anda berakhir. Masuk lagi untuk melanjutkan.",
  disabled: "Tinjauan Pantau belum aktif untuk proyek ini.",
  not_found: "Unggahan atau proyek aktif sudah tidak tersedia. Muat ulang pencarian.",
  ineligible: "Unggahan ini tidak memenuhi syarat untuk proyek aktif.",
  conflict: "Rute berubah di tempat lain. Periksa rute terbaru sebelum memilih lagi.",
};
const AUTOMATIC_DESTINATION_LABEL = {
  ...MANUAL_ROUTE_LABEL,
  mention: "Sebutan",
  excluded: "Dikecualikan",
} satisfies Record<TriageJudgment["destination"], string>;

const BUTTON = "workspace-feedback inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 aria-disabled:opacity-60";

type ReviewProps = {
  searchId: string;
  resultId: string;
  result: SnapshotResult;
  projectId: string | null;
};

export function ResultReviewDialog(props: ReviewProps & {
  open: boolean;
  onClose: () => void;
  projectName: string | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-slate-950/50" />
        <Dialog.Popup
          finalFocus={props.returnFocus}
          className="fixed bottom-0 left-1/2 z-50 max-h-[calc(100dvh-1rem)] w-full max-w-lg -translate-x-1/2 overflow-y-auto overscroll-contain rounded-t-2xl border border-border bg-surface shadow-2xl outline-none sm:bottom-auto sm:top-1/2 sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100%-2rem)] sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
            <div className="min-w-0 self-center">
              <Dialog.Title className="text-lg font-semibold tracking-tight">Tinjau unggahan</Dialog.Title>
              <Dialog.Description className="mt-0.5 wrap-anywhere text-sm text-muted-foreground">
                {props.projectId
                  ? <>Proyek aktif · <strong className="font-semibold text-foreground">{props.projectName}</strong></>
                  : "Belum ada proyek aktif."}
              </Dialog.Description>
            </div>
            <Dialog.Close className={`${BUTTON} shrink-0 hover:bg-surface-subtle`} aria-label="Tutup tinjauan">
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </header>
          <ReviewContent
            key={props.resultId}
            searchId={props.searchId}
            resultId={props.resultId}
            result={props.result}
            projectId={props.projectId}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ReviewContent({ searchId, resultId, result, projectId }: ReviewProps) {
  const router = useRouter();
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [reload, setReload] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [undo, setUndo] = useState<UndoInput | null>(null);
  const inFlight = useRef(false);
  const retry = useRef<RouteInput | null>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!projectId) return;
    let current = true;
    void readCariReviewAction({ searchId, resultId, projectId }).then((response) => {
      if (!current) return;
      if (response.ok) setReview(response);
      else setFeedback({ tone: "error", text: ERROR_LABEL[response.error] });
    }).catch(() => {
      if (!current) return;
      setReadFailed(true);
      setFeedback({ tone: "error", text: "Tinjauan gagal dimuat." });
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [projectId, reload, resultId, searchId]);

  function refreshReview() {
    setLoading(true);
    setReadFailed(false);
    setReview(null);
    setReload((value) => value + 1);
  }

  async function run(action: () => Promise<void>, error: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await action();
    } catch {
      setFeedback({ tone: "error", text: error });
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  function updateRoute(response: ReviewWriteResult, reviewBeforeWrite: Review, undoing: boolean) {
    setUndo(null);
    if (!response.ok) {
      setFeedback({ tone: "error", text: ERROR_LABEL[response.error] });
      if (response.error === "conflict") {
        // Keep focus inside the dialog when the stale route controls are disabled.
        feedbackRef.current?.focus();
        refreshReview();
      } else {
        setReview(null);
      }
      return;
    }
    const { mentionId, route, replayed } = response;
    setReview({ ...reviewBeforeWrite, mentionId, route });
    if (!undoing && !replayed && projectId && route.revision) {
      setUndo({ projectId, mentionId, revision: route.revision });
    }
    setFeedback({
      tone: "status",
      text: undoing ? "Keputusan diurungkan."
        : replayed ? "Rute terbaru ditampilkan."
        : route.destination ? `Disimpan ke ${MANUAL_ROUTE_LABEL[route.destination]}.` : "Keputusan tersimpan.",
    });
  }

  function choose(destination: ReviewDestination) {
    if (!projectId || !review) return;
    void run(async () => {
      const previous = retry.current;
      const input = previous?.destination === destination && previous.expectedRevision === review.route.revision
        ? previous
        : { searchId, resultId, projectId, destination, expectedRevision: review.route.revision, requestId: crypto.randomUUID() };
      retry.current = input;
      const response = await routeCariResultAction(input);
      retry.current = null;
      updateRoute(response, review, false);
    }, "Keputusan gagal disimpan. Coba lagi.");
  }

  function undoRoute() {
    if (!undo || !review) return;
    void run(async () => {
      const response = await undoCariRouteAction(undo);
      retry.current = null;
      // The Undo control may disappear when its revision is consumed.
      feedbackRef.current?.focus({ preventScroll: true });
      updateRoute(response, review, true);
    }, "Keputusan gagal diurungkan. Coba lagi.");
  }

  function monitor() {
    void run(async () => {
      const response = await monitorAsProjectAction(searchId);
      if (response.ok) router.push(response.href);
      else setFeedback({ tone: "error", text: "Proyek belum bisa disiapkan. Coba lagi." });
    }, "Proyek belum bisa disiapkan. Coba lagi.");
  }

  const evidence = review?.evidence ?? result;
  const platform = platformName(evidence.platform);
  const href = originalPostHref(evidence.platform, evidence.url);
  const judgment = review?.triage?.judgment;
  const destination = review?.route.destination;

  return (
    <div className="grid min-w-0 gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))] sm:p-6">
      <section className="min-w-0 rounded-xl border border-border bg-surface-subtle/60 p-3.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <PlatformTile platform={evidence.platform} />
          <p className="min-w-0 wrap-anywhere font-semibold">
            {platform}
            {evidence.authorHandle || evidence.authorName
              ? <span className="font-normal text-muted-foreground"> · {evidence.authorHandle || evidence.authorName}</span>
              : null}
          </p>
        </div>
        {evidence.title ? <p className="mt-2.5 wrap-anywhere font-semibold">{evidence.title}</p> : null}
        {evidence.text !== evidence.title ? (
          <p className="mt-2.5 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">{evidence.text || "Tanpa teks"}</p>
        ) : null}
        {href ? (
          <a className={`${BUTTON} -ml-3 mt-1 gap-1 text-primary hover:bg-primary/5`}
            href={href} target="_blank" rel="noopener noreferrer"
            aria-label={`Buka unggahan asli di ${platform} (tab baru)`}>
            Buka unggahan asli <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        ) : null}
      </section>
      <section aria-label="Penilaian otomatis" className="min-w-0">
        <h3 className="text-sm font-semibold">Penilaian otomatis</h3>
        <p role="status" className="mt-1 text-sm text-muted-foreground">
          {loading ? "Memuat penilaian…"
            : review?.triage ? TRIAGE_STATUS_LABEL[review.triage.status]
            : review?.mentionId ? TRIAGE_STATUS_LABEL.pending
            : projectId && !review ? TRIAGE_STATUS_LABEL.unavailable
            : "Belum ada penilaian otomatis."}
        </p>
        {judgment ? (
          <>
            <p className="mt-2 text-sm font-semibold">Otomatis: {AUTOMATIC_DESTINATION_LABEL[judgment.destination]}</p>
            <p className="mt-1 text-sm leading-relaxed">{TRIAGE_REASON_LABEL[judgment.reason]}</p>
          </>
        ) : null}
        {judgment?.verifiedExcerpt ? (
          <blockquote className="mt-2 wrap-anywhere rounded-r-lg border-l-2 border-info bg-info-bg px-3 py-2 text-sm leading-relaxed">
            {judgment.verifiedExcerpt}
          </blockquote>
        ) : null}
      </section>
      <section aria-label="Rute Pantau" className="grid gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold">Rute Pantau</h3>
          {destination ? <ManualRouteTag destination={destination} /> : null}
        </div>
        <div className="grid grid-cols-1 gap-2 min-[375px]:grid-cols-2">
          <button type="button" className={`${BUTTON} border border-primary bg-primary text-primary-foreground enabled:hover:brightness-95`}
            disabled={!review} aria-disabled={busy} onClick={() => choose("attention")}>
            Perlu perhatian
          </button>
          <button type="button" className={`${BUTTON} border border-border bg-surface enabled:hover:bg-surface-subtle`}
            disabled={!review} aria-disabled={busy} onClick={() => choose("ambiguous")}>
            Belum yakin
          </button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <p ref={feedbackRef} tabIndex={-1} role={feedback?.tone === "error" ? "alert" : "status"}
            className={feedback?.tone === "error" ? "text-sm text-negatif" : "text-sm text-muted-foreground"}>
            {feedback?.text}
          </p>
          {undo ? (
            <button type="button" className={`${BUTTON} text-primary hover:bg-primary/5`} aria-disabled={busy} onClick={undoRoute}>
              Urungkan
            </button>
          ) : null}
          {!projectId ? (
            <button type="button" className={`${BUTTON} border border-primary text-primary hover:bg-primary/5`} aria-disabled={busy} onClick={monitor}>
              Pantau sebagai proyek
            </button>
          ) : null}
          {readFailed ? (
            <button type="button" className={`${BUTTON} text-primary hover:bg-primary/5`} onClick={refreshReview}>
              Coba lagi
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
