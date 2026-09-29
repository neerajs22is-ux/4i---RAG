"use client";

import { ChevronDown, CornerUpLeft } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AnswerContent } from "@/components/chat/answer-content";
import {
  AnswerStateHeader,
  ConflictNote,
  GroundingCaution,
  RefusalNote,
} from "@/components/chat/answer-states";
import { CopyButton } from "@/components/chat/copy-button";
import type { AnswerView } from "@/lib/chat/answer-view";
import { citedOrder, citationLabel } from "@/lib/chat/citations";
import { formatDuration } from "@/lib/format";
import { DURATION, EASE } from "@/lib/motion";
import { cn } from "cn";

/**
 * Assistant message — the primary reading surface.
 *
 * Hierarchy is carried by typography and whitespace rather than cards: a small
 * state header, the answer itself in markdown, optional state notes, one
 * supporting-passage row per citation (metadata only), then a quiet action row
 * with copy and a provenance disclosure built from real timings.
 *
 * Citations navigate directly in both directions with no intermediate popup:
 * selecting a number in the answer scrolls its supporting passage into view
 * and highlights it, and each passage offers a single way back to the claim
 * in the answer. Both moves scroll the target into view, focus it and give it
 * a short emphasis — no passage text is implied, only the metadata the backend
 * returned (document, page, retrieval rank, chunk id).
 *
 * Only freshly received answers animate in; a loaded transcript appears
 * immediately so opening a conversation never feels slow.
 */

const HIGHLIGHT_MS = 2200;

type Highlight = { target: "marker" | "source"; n: number };

export function AssistantMessage({
  view,
  entrance = false,
  scope,
}: {
  view: AnswerView;
  /** Animate only freshly received answers, never a loaded transcript. */
  entrance?: boolean;
  /** Unique per rendered answer — scopes marker ids and navigation targets. */
  scope: string;
}) {
  const isRefusal = view.label === "insufficient";
  const isConflict = view.state === "conflicting";
  const sources = citedOrder(view.answer, view.citations);
  const documentCount = new Set(
    sources.map((citation) => citation.document_id || citation.file_name),
  ).size;
  const hasProvenance = view.steps.length > 0 || Boolean(view.model);

  const prefersReducedMotion = useReducedMotion();
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const pulse = useCallback((target: Highlight["target"], n: number) => {
    setHighlight({ target, n });
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(
      () => setHighlight(null),
      HIGHLIGHT_MS,
    );
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  const navigate = useCallback(
    (id: string) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "center",
      });
    },
    [prefersReducedMotion],
  );

  const showSource = useCallback(
    (n: number) => {
      pulse("source", n);
      navigate(`source-${scope}-${n}`);
    },
    [navigate, pulse, scope],
  );

  const showMarker = useCallback(
    (n: number) => {
      pulse("marker", n);
      // Repeated citations share one `n` but have unique marker ids; the
      // first mention keeps the bare id, so returning always lands there.
      navigate(`marker-${scope}-${n}`);
    },
    [navigate, pulse, scope],
  );

  const highlightedSource = highlight?.target === "source" ? highlight.n : null;
  const highlightedMarker = highlight?.target === "marker" ? highlight.n : null;

  const body = (
    <>
      <AnswerStateHeader view={view} />

      <div className="mt-2.5">
        {isRefusal ? (
          <RefusalNote answer={view.answer} />
        ) : (
          <AnswerContent
            answer={view.answer}
            citations={view.citations}
            scope={scope}
            highlightedMarker={highlightedMarker}
            onShowSource={showSource}
          />
        )}
      </div>

      {isConflict ? <ConflictNote /> : null}

      {!isConflict && view.grounded === false && view.groundingNote ? (
        <GroundingCaution note={view.groundingNote} />
      ) : null}

      {sources.length > 0 ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
              Supporting passages — {sources.length}{" "}
              {sources.length === 1 ? "passage" : "passages"}
            </p>
            {documentCount > 0 ? (
              <p className="text-muted-foreground/80 text-2xs">
                from {documentCount}{" "}
                {documentCount === 1 ? "document" : "documents"}
              </p>
            ) : null}
          </div>
          <ol className="mt-2 space-y-2">
            {sources.map((citation) => {
              const active = highlightedSource === citation.n;
              return (
                <li
                  key={citation.n}
                  id={`source-${scope}-${citation.n}`}
                  data-citation={citation.n}
                  tabIndex={-1}
                  aria-label={`Supporting passage ${citation.n}: ${citationLabel(citation)}`}
                  className={cn(
                    "focus-visible:ring-ring/50 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2",
                    active
                      ? "border-primary/40 bg-accent shadow-sm"
                      : "border-border bg-card",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md font-mono text-2xs",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {citation.n}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-xs font-medium break-words">
                      {citation.file_name}
                    </p>
                    <p className="text-muted-foreground mt-0.5 font-mono text-2xs">
                      {citation.page != null
                        ? `p. ${citation.page}`
                        : "No page reported"}{" "}
                      ·{" "}
                      {citation.fused_rank != null
                        ? `rank ${citation.fused_rank}`
                        : "rank —"}{" "}
                      ·{" "}
                      <span
                        title={citation.chunk_id}
                        className="break-all"
                      >
                        {citation.chunk_id
                          ? `${citation.chunk_id.slice(0, 12)}…`
                          : "—"}
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={() => showMarker(citation.n)}
                      aria-label={`Back to where source ${citation.n} is cited in the answer`}
                      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mt-1.5 inline-flex cursor-pointer items-center gap-1 rounded text-2xs transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2"
                    >
                      <CornerUpLeft
                        className="size-3"
                        aria-hidden="true"
                      />
                      Back to claim [{citation.n}]
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <CopyButton text={view.answer} />

        {hasProvenance ? (
          <details className="group/details">
            <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 text-2xs outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
              How this answer was made
              <ChevronDown
                className="size-3 transition-transform duration-[var(--duration-fast)] group-open/details:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <dl className="text-muted-foreground mt-2 space-y-1 pl-1.5 font-mono text-2xs">
              {view.steps.map((step) => (
                <div key={step.label} className="flex justify-between gap-4">
                  <dt>{step.label}</dt>
                  <dd>{formatDuration(step.ms)}</dd>
                </div>
              ))}
              {view.model ? (
                <div className="flex justify-between gap-4">
                  <dt>Model</dt>
                  <dd className="max-w-[14rem] truncate" title={view.model}>
                    {view.model}
                  </dd>
                </div>
              ) : null}
              {view.promptVersion ? (
                <div className="flex justify-between gap-4">
                  <dt>Prompt</dt>
                  <dd>{view.promptVersion}</dd>
                </div>
              ) : null}
            </dl>
            <p className="text-muted-foreground/70 mt-1.5 max-w-md pl-1.5 text-2xs text-pretty">
              Timings and model identification only. The service does not expose
              model reasoning.
            </p>
          </details>
        ) : null}
      </div>
    </>
  );

  if (!entrance) {
    return (
      <article className="group" aria-label="Answer">
        {body}
      </article>
    );
  }

  return (
    <motion.article
      className="group"
      aria-label="Answer"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.normal, ease: EASE.decelerate }}
    >
      {body}
    </motion.article>
  );
}
