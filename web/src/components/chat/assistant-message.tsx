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
import { DURATION, EASE } from "@/lib/motion";
import { cn } from "cn";

/**
 * Assistant message — the primary reading surface.
 *
 * Reading order is answer first: a small state header, the answer itself on
 * a quiet surface, optional state notes, a compact copy action, then the
 * collapsible supporting-evidence disclosure (collapsed by default; one
 * tight row per citation when open: document, page and the verbatim chunk
 * excerpt when the backend provided one). Markers reopen it on demand.
 *
 * Citations navigate directly in both directions with no intermediate popup:
 * selecting a number in the answer opens the disclosure when collapsed,
 * scrolls its evidence row into view and highlights it, and each row's
 * number badge returns to the claim in the answer (the excerpt text itself
 * stays selectable). Both moves scroll the target into view, focus it and
 * give it a short emphasis.
 *
 * The backend returns citation metadata plus a verbatim excerpt of the exact
 * retrieved chunk (or no excerpt on rows persisted before excerpts existed,
 * which render without one) — nothing is invented or paraphrased. Internal
 * chunk ids stay in the data for citation identity and navigation but are
 * never rendered.
 *
 * Only freshly received answers animate in (one article-level reveal — the
 * backend returns a completed response, so nothing streams); a loaded
 * transcript appears immediately so opening a conversation never feels slow.
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

  const prefersReducedMotion = useReducedMotion();
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const highlightTimer = useRef<number | null>(null);
  /** Per-row excerpt expansion; collapsed rows clamp to one line. */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /**
   * Evidence disclosure state. Collapsed by default so the answer itself is
   * always the focus — including right after generation, because the first
   * answer remounts as a stored transcript when the URL moves onto `/c/<id>`.
   * Markers reopen it on demand either way.
   */
  const [evidenceOpen, setEvidenceOpen] = useState(false);

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
      // Open the disclosure first when collapsed; the effect below scrolls
      // to the row once it is mounted.
      setEvidenceOpen(true);
      pulse("source", n);
    },
    [pulse],
  );

  // Navigate to a highlighted evidence row after render, so opening the
  // disclosure from a marker click still lands on the right row. The pulse
  // always creates a fresh highlight object, so repeat visits re-fire.
  useEffect(() => {
    if (highlight?.target === "source" && evidenceOpen) {
      navigate(`source-${scope}-${highlight.n}`);
    }
  }, [highlight, evidenceOpen, navigate, scope]);

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
            reveal={entrance}
          />
        )}
      </div>

      {isConflict ? <ConflictNote /> : null}

      {!isConflict && view.grounded === false && view.groundingNote ? (
        <GroundingCaution note={view.groundingNote} />
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        <CopyButton text={view.answer} />
      </div>

      {sources.length > 0 ? (
        <div className="mt-3 border-t border-border/60 pt-1">
          <button
            type="button"
            onClick={() => setEvidenceOpen((open) => !open)}
            aria-expanded={evidenceOpen}
            aria-controls={`evidence-list-${scope}`}
            aria-label={`Supporting evidence: ${sources.length} ${sources.length === 1 ? "source" : "sources"} across ${documentCount} ${documentCount === 1 ? "document" : "documents"}`}
            className="focus-visible:ring-ring/50 flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 text-left transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2"
          >
            <span className="text-foreground text-2xs font-medium tracking-wide uppercase">
              Supporting evidence
            </span>
            <span className="text-muted-foreground text-2xs">
              {sources.length} {sources.length === 1 ? "source" : "sources"}{" "}
              · {documentCount}{" "}
              {documentCount === 1 ? "document" : "documents"}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform duration-[var(--duration-fast)]",
                evidenceOpen && "rotate-180",
              )}
            />
          </button>
          {evidenceOpen ? (
            <div
              id={`evidence-list-${scope}`}
              role="region"
              aria-label="Supporting evidence"
            >
              <ol className="divide-border/70 divide-y">
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
                  <button
                    type="button"
                    onClick={() => showMarker(citation.n)}
                    aria-label={`Back to where source ${citation.n} is cited in the answer`}
                    title={
                      citation.fused_rank != null
                        ? `Retrieved at rank ${citation.fused_rank}`
                        : `Source ${citation.n}`
                    }
                    className={cn(
                      "focus-visible:ring-ring/50 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent font-mono text-2xs transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground hover:border-primary/40 hover:text-primary-strong",
                    )}
                  >
                    {citation.n}
                  </button>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="flex min-w-0 items-baseline gap-1 text-xs">
                      <span
                        className="text-foreground min-w-0 flex-1 truncate font-medium"
                        title={citation.file_name}
                      >
                        {citation.file_name}
                      </span>
                      <span className="text-muted-foreground shrink-0">
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
                          !isOpen && "line-clamp-1",
                        )}
                      >
                        {excerpt}
                      </blockquote>
                    ) : null}
                    {collapsible ? (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(citation.n)}
                        aria-expanded={isOpen}
                        aria-label={
                          isOpen
                            ? `Collapse excerpt for source ${citation.n}`
                            : `Expand excerpt for source ${citation.n}`
                        }
                        className="text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring/50 mt-0.5 cursor-pointer rounded text-2xs underline-offset-2 outline-none transition-colors duration-[var(--duration-fast)] hover:underline focus-visible:ring-2"
                      >
                        {isOpen ? "Show less" : "Show more"}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}

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
