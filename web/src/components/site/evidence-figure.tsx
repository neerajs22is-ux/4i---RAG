import { ChevronDown } from "lucide-react";

import { EvidenceStatusBadge } from "@/components/foundation/evidence-status";

/**
 * Evidence figures.
 *
 * Static product fragments for the evidence section, built from the real
 * answer surface: the refusal is the backend's exact refusal constant
 * (`REFUSAL_TEXT` in `supabase/functions/_shared/grounding.ts`) with the
 * product's own supporting copy; the marker figure shows the direct
 * claim → passage pairing the answer surface uses. Illustrative content is
 * generic professional-firm material; no real workspace is reproduced.
 */

/** Exact refusal constant from the answering pipeline. */
const REFUSAL_TEXT =
  "I could not find enough relevant information in the documents to answer that.";

export function RefusalDemo() {
  return (
    <div
      className="bg-background hairline rounded-2xl border p-3.5 shadow-sm sm:p-4"
      aria-label="Example refusal"
    >
      <div className="bg-secondary/70 hairline rounded-xl border px-3.5 py-2.5">
        <p className="text-sm leading-relaxed text-pretty">
          What notice period applies to the supplier renewal clause?
        </p>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <EvidenceStatusBadge state="insufficient" />
        <span className="text-muted-foreground font-mono text-2xs">
          0 cited
        </span>
      </div>

      <div className="bg-neutral-state-muted/60 hairline mt-2.5 rounded-lg border p-3">
        <p className="text-sm text-pretty">{REFUSAL_TEXT}</p>
        <p className="text-muted-foreground mt-2 text-xs text-pretty">
          The documents in this workspace do not cover this question, so
          nothing was written to fill the gap.
        </p>
      </div>
    </div>
  );
}

export function MarkerLinkDemo() {
  return (
    <div
      className="bg-background hairline rounded-2xl border p-3.5 shadow-sm sm:p-4"
      aria-label="Example cited answer"
    >
      <p className="text-sm leading-relaxed text-pretty">
        Payment is released within thirty days of partner approval.
        <sup className="bg-primary text-primary-foreground ml-0.5 inline-flex items-center rounded-md border border-transparent px-1 font-mono text-2xs align-super">
          [2]
        </sup>
      </p>

      <div className="border-border/60 mt-3 flex w-full items-center gap-2 border-t pt-1">
        <span className="text-foreground text-2xs font-medium tracking-wide uppercase">
          Supporting evidence
        </span>
        <span className="text-muted-foreground text-2xs">
          1 source · 1 document
        </span>
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground ml-auto size-3.5 shrink-0 rotate-180"
        />
      </div>

      <ol className="divide-border/70 divide-y">
        <li className="flex items-start gap-2 py-1.5">
          <span className="bg-primary text-primary-foreground inline-flex size-5 shrink-0 items-center justify-center rounded border border-transparent font-mono text-2xs">
            2
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="flex min-w-0 items-baseline gap-1 text-xs">
              <span className="text-foreground min-w-0 flex-1 truncate font-medium">
                Client Advisory Notes.pdf
              </span>
              <span className="text-muted-foreground shrink-0">· p. 12</span>
            </p>
            <blockquote className="border-border text-foreground/80 mt-1 border-l-2 pl-2 text-xs break-words whitespace-pre-wrap">
              Release of payment is subject to thirty days from the date of
              the partner&apos;s approval.
            </blockquote>
          </div>
        </li>
      </ol>
    </div>
  );
}
