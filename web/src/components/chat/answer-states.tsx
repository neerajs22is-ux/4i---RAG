"use client";

import { TriangleAlert } from "lucide-react";

import type { AnswerView } from "@/lib/chat/answer-view";
import { EvidenceStatusBadge } from "@/components/foundation/evidence-status";
import { Badge } from "@/components/ui/badge";

/**
 * States attached to a stored or live answer.
 *
 * Each note says only what the backend established: a refusal is the pipeline
 * declining to answer from insufficient evidence, and a conflict is retrieved
 * passages disagreeing — the system presents the disagreement and does not pick
 * a side. No percentages, no scores, no implied certainty.
 */

/** Refusal: an outcome, not an error. */
export function RefusalNote({ answer }: { answer: string }) {
  return (
    <div className="bg-neutral-state-muted/60 hairline rounded-lg border p-3">
        <p className="text-base text-pretty">{answer}</p>
      <p className="text-muted-foreground mt-2 text-xs text-pretty">
        The documents in this workspace do not cover this question, so nothing
        was written to fill the gap.
      </p>
    </div>
  );
}

export function ClarificationNote() {
  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary" className="text-2xs">
        Clarification
      </Badge>
      <span className="text-muted-foreground text-2xs">
        The question needed a little more detail before retrieval.
      </span>
    </div>
  );
}

export function ConflictNote() {
  return (
    <p className="bg-conflict-muted/50 border-conflict/20 text-conflict mt-3 rounded-lg border px-3 py-2 text-xs text-pretty">
      The retrieved sources disagree on this point. The answer sets out the
      disagreement rather than choosing a side.
    </p>
  );
}

/** Tripwire caution — wording comes from the backend, not from the UI. */
export function GroundingCaution({ note }: { note: string }) {
  return (
    <p className="bg-warning-muted/60 border-warning/25 text-warning mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs text-pretty">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-foreground/80">{note}</span>
    </p>
  );
}

export function AnswerStateHeader({ view }: { view: AnswerView }) {
  if (view.label === "clarification") return <ClarificationNote />;
  if (!view.state) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <EvidenceStatusBadge state={view.state} />
      {view.retrieved !== null ? (
        <span className="text-muted-foreground font-mono text-2xs">
          {view.retrieved} retrieved · {view.citations.length} cited
        </span>
      ) : null}
    </div>
  );
}
