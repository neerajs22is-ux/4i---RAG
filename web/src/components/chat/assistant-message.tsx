"use client";

import { ChevronDown } from "lucide-react";
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
 * state header, the answer itself in markdown, optional state notes, a compact
 * source list (one tight row per citation: document, page, the verbatim
 * chunk excerpt when the backend provided one, and retrieval rank as subtle
 * metadata), then a quiet action row with copy and a provenance disclosure
 * built from real timings.
 *
 * Citations navigate directly in both directions with no intermediate popup:
 * selecting a number in the answer scrolls its source row into view and
 * highlights it, and each row offers a single way back to the claim in the
 * answer. Both moves scroll the target into view, focus it and give it a
 * short emphasis.
 *
 * The backend returns citation metadata plus a verbatim excerpt of the exact
 * retrieved chunk (or no excerpt on rows persisted before excerpts existed,
 * which render without one) — nothing is invented or paraphrased. Internal
 * chunk ids stay in the data for citation identity and navigation but are
 * never rendered.
 *
 * Only freshly received answers animate in; a loaded transcript appears
 * immediately so opening a conversation never feels slow.
 */

const HIGHLIGHT_MS = 2200;

/** Excerpts longer than this get a collapsed Show more/less treatment. */
const EXCERPT_COLLAPSE_AT = 280;

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
  /** Per-row excerpt expansion; collapsed rows clamp to three lines. */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpanded = useCallback((n: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }, []);

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
        <div className="mt-3">
          <p className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
            Sources — {sources.length}{" "}
            {sources.length === 1 ? "passage" : "passages"} ·{" "}
            {documentCount} {documentCount === 1 ? "document" : "documents"}
          </p>
          <ol className="divide-border/70 mt-1 divide-y">
            {sources.map((citation) => {
              const active = highlightedSource === citation.n;
              const excerpt = citation.excerpt ?? null;
              const isOpen = expanded.has(citation.n);
              const collapsible =
                excerpt !== null && excerpt.length > EXCERPT_COLLAPSE_AT;
              return (
                <li
                  key={citation.n}
                  id={`source-${scope}-${citation.n}`}
                  data-citation={citation.n}
                  tabIndex={-1}
                  aria-label={`Source ${citation.n}: ${citationLabel(citation)}`}
                  className={cn(
                    "focus-visible:ring-ring/50 flex items-start gap-2 py-1.5 transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2",
                    active && "-mx-1.5 rounded-md bg-accent px-1.5",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-flex size-5 shrink-0 items-center justify-center rounded font-mono text-2xs",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {citation.n}
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-foreground truncate text-xs">
                      <span className="font-medium">{citation.file_name}</span>{" "}
                      <span className="text-muted-foreground">
                        ·{" "}
                        {citation.page != null
                          ? `p. ${citation.page}`
                          : "page not reported"}
                      </span>
                    </p>
                    {excerpt !== null ? (
                      <blockquote
                        className={cn(
                          "border-border text-foreground/80 mt-1 border-l-2 pl-2 text-xs break-words whitespace-pre-wrap",
                          !isOpen && "line-clamp-3",
                        )}
                      >
                        {excerpt}
                      </blockquote>
                    ) : null}
                    <p className="text-muted-foreground/80 mt-0.5 text-2xs">
                      {citation.fused_rank != null
                        ? `rank ${citation.fused_rank} · `
                        : null}
                      {collapsible ? (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleExpanded(citation.n)}
                            aria-expanded={isOpen}
                            aria-label={
                              isOpen
                                ? `Collapse excerpt for source ${citation.n}`
                                : `Expand excerpt for source ${citation.n}`
                            }
                            className="hover:text-foreground focus-visible:ring-ring/50 cursor-pointer rounded underline-offset-2 outline-none transition-colors duration-[var(--duration-fast)] hover:underline focus-visible:ring-2"
                          >
                            {isOpen ? "Show less" : "Show more"}
                          </button>
                          {" · "}
                        </>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => showMarker(citation.n)}
                        aria-label={`Back to where source ${citation.n} is cited in the answer`}
                        className="hover:text-foreground focus-visible:ring-ring/50 cursor-pointer rounded underline-offset-2 outline-none transition-colors duration-[var(--duration-fast)] hover:underline focus-visible:ring-2"
                      >
                        Back to claim {citation.n}
                      </button>
                    </p>
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
