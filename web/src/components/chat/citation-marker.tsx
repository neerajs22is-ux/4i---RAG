"use client";

import { CornerDownRight, FileText } from "lucide-react";
import { useRef, useState } from "react";

import type { AskCitation } from "@/lib/api/types";
import { citationLabel } from "@/lib/chat/citations";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "cn";

/**
 * Inline citation marker.
 *
 * Renders the `[Sn]` the model wrote as a real, focusable control (an anchor is
 * supplied by the markdown renderer; this is its content). Opening it shows
 * only the metadata the backend actually returns — document, page, retrieval
 * rank and the chunk id.
 *
 * Passage text is deliberately absent: `/ask` does not return it yet, and no
 * substitute is invented here (no snippets, no similarity percentages).
 *
 * The popover can send the reader to the matching row in the answer's cited
 * sources list; the row's chips send them back to the marker. Both directions
 * move focus, so the navigation works for keyboard users too.
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
  /** DOM id so the cited-sources list can come back to this marker. */
  id?: string;
  /** Briefly emphasised after arriving from the cited-sources list. */
  highlighted?: boolean;
  /** Opens the answer's cited-sources list at source `n`. */
  onShowSource?: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // When the reader follows "Show in cited sources", focus stays on the
  // destination. Radix would otherwise return it to this trigger on close.
  const navigatedAway = useRef(false);

  if (!citation) {
    // Never fabricate a source for a marker we cannot resolve.
    return (
      <sup className="bg-muted text-muted-foreground ml-0.5 rounded px-1 font-mono text-2xs">
        {n}
      </sup>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          className={cn(
            "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 ml-0.5 inline-flex min-w-4 items-center justify-center rounded px-1 font-mono text-2xs align-super transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2",
            highlighted && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
          )}
          aria-label={`Source ${n}: ${citationLabel(citation)}`}
        >
          {n}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-3"
        onCloseAutoFocus={(event) => {
          if (navigatedAway.current) {
            event.preventDefault();
            navigatedAway.current = false;
          }
        }}
      >
        <p className="text-2xs text-muted-foreground font-medium tracking-wide uppercase">
          Cited source
        </p>
        <p className="mt-1.5 flex items-start gap-2 text-sm font-medium">
          <FileText className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{citation.file_name}</span>
        </p>
        <dl className="text-muted-foreground mt-2.5 space-y-1 font-mono text-2xs">
          <div className="flex justify-between gap-3">
            <dt>Page</dt>
            <dd>{citation.page ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Retrieved at rank</dt>
            <dd>{citation.fused_rank ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Passage</dt>
            <dd className="max-w-[10rem] truncate" title={citation.chunk_id}>
              {citation.chunk_id ? citation.chunk_id.slice(0, 12) : "—"}
            </dd>
          </div>
        </dl>
        {onShowSource ? (
          <button
            type="button"
            onClick={() => {
              navigatedAway.current = true;
              onShowSource(n);
              setOpen(false);
            }}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 hairline mt-3 flex w-full items-center gap-1.5 border-t pt-2.5 text-2xs transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2"
          >
            <CornerDownRight className="size-3" aria-hidden="true" />
            Show in cited sources
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
