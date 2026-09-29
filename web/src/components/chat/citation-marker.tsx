"use client";

import type { AskCitation } from "@/lib/api/types";
import { citationLabel } from "@/lib/chat/citations";
import { cn } from "cn";

/**
 * Inline citation marker.
 *
 * The `[Sn]` the model wrote renders as a real, focusable button. Activating
 * it navigates directly to the matching supporting passage in the answer's
 * source list — there is no intermediate popup. The button's accessible name
 * and hover title retain the metadata the backend actually returned
 * (document, page, retrieval rank); the full metadata row lives at the
 * destination.
 *
 * Passage text is deliberately absent: `/ask` does not return it yet, and no
 * substitute is invented here (no snippets, no similarity percentages).
 *
 * Citation identity (`n` / `chunk_id` / `document_id`) is unchanged; this
 * component only changes how the reader travels between the claim and its
 * evidence.
 */
export function CitationMarker({
  n,
  citation,
  id,
  highlighted = false,
  onShowSource,
}: {
  n: number;
  citation?: AskCitation;
  /** DOM id so the supporting-passage list can come back to this marker. */
  id?: string;
  /** Briefly emphasised after arriving from the supporting-passage list. */
  highlighted?: boolean;
  /** Navigates directly to supporting passage `n`. */
  onShowSource?: (n: number) => void;
}) {
  if (!citation) {
    // Never fabricate a source for a marker we cannot resolve.
    return (
      <sup className="bg-muted text-muted-foreground ml-0.5 rounded px-1 font-mono text-2xs">
        {n}
      </sup>
    );
  }

  const label = citationLabel(citation);
  const detail =
    citation.fused_rank != null ? ` · rank ${citation.fused_rank}` : "";
  const title = `${label}${detail}`;

  if (!onShowSource) {
    return (
      <sup
        title={title}
        className="bg-muted text-foreground ml-0.5 rounded border border-border px-1 font-mono text-2xs"
      >
        {n}
      </sup>
    );
  }

  return (
    <button
      type="button"
      id={id}
      data-citation={n}
      onClick={() => onShowSource(n)}
      title={title}
      aria-label={`Source ${n}: ${label} — show supporting passage`}
      className={cn(
        "border-border bg-muted text-foreground hover:border-primary/40 hover:bg-accent hover:text-primary focus-visible:ring-ring/50 ml-0.5 inline-flex min-w-5 cursor-pointer items-center justify-center rounded-md border px-1 font-mono text-2xs align-super transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2",
        highlighted &&
          "border-primary/40 bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
      )}
    >
      {n}
    </button>
  );
}
