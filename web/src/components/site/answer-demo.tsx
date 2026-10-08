import { ChevronDown } from "lucide-react";

import { EvidenceStatusBadge } from "@/components/foundation/evidence-status";

/**
 * Static product demonstration.
 *
 * This is the real answer surface rendered as marketing content: the same
 * question bubble, grounding state, cited answer and supporting-evidence rows
 * the application shows, built from the same design tokens and typography.
 * It is deliberately non-interactive — there is nothing behind it to open —
 * and every fragment is annotated as an illustration in the hero.
 *
 * The demo content is generic professional-firm material; no real workspace,
 * client or document is reproduced, and no statistic is claimed.
 */

/** Inline citation marker, styled exactly like the interactive control. */
function DemoMarker({ n }: { n: number }) {
  return (
    <sup className="bg-muted text-foreground border-border ml-0.5 inline-flex items-center rounded-md border px-1 font-mono text-2xs align-super">
      [{n}]
    </sup>
  );
}

const EVIDENCE = [
  {
    n: 1,
    file: "Year-End Procedures.pdf",
    page: 22,
    excerpt:
      "Do not finalise a depreciation schedule until the asset register and the fixed-asset ledger reconcile, line by line, for every class of asset.",
  },
  {
    n: 2,
    file: "Fixed Assets Advisory Note.pdf",
    page: 9,
    excerpt:
      "For additions during the year, compute depreciation from the date the asset was first put to use; the invoice date is not the acquisition date for this purpose.",
  },
];

export function DemoQuestion() {
  return (
    <div className="bg-secondary/70 hairline rounded-xl border px-3.5 py-2.5">
      <p className="text-base leading-relaxed break-words whitespace-pre-wrap">
        What should we confirm before finalising a client&apos;s depreciation
        schedule?
      </p>
    </div>
  );
}

export function DemoAnswer() {
  return (
    <article aria-label="Example answer">
      <div className="flex flex-wrap items-center gap-2">
        <EvidenceStatusBadge state="supported" />
        <span className="text-muted-foreground font-mono text-2xs">
          8 retrieved · 2 cited
        </span>
      </div>

      <div className="bg-card hairline mt-2.5 rounded-xl border px-4 py-3 text-base shadow-xs">
        <p className="my-3 leading-relaxed text-pretty first:mt-1 last:mb-1">
          Confirm the asset register reconciles with the fixed-asset ledger
          before the schedule is finalised.
          <DemoMarker n={1} />
        </p>
        <p className="my-3 leading-relaxed text-pretty first:mt-1 last:mb-1">
          For assets acquired during the year, depreciation runs from the date
          the asset was first put to use, not the invoice date.
          <DemoMarker n={2} />
        </p>
      </div>
    </article>
  );
}

export function DemoEvidence() {
  return (
    <div aria-label="Example supporting evidence">
      <div className="border-border/60 flex w-full items-center gap-2 border-t pt-1">
        <span className="text-foreground text-2xs font-medium tracking-wide uppercase">
          Supporting evidence
        </span>
        <span className="text-muted-foreground text-2xs">
          2 sources · 2 documents
        </span>
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground ml-auto size-3.5 shrink-0 rotate-180"
        />
      </div>
      <ol className="divide-border/70 divide-y">
        {EVIDENCE.map((source) => (
          <li key={source.n} className="flex items-start gap-2 py-1.5">
            <span
              className="bg-muted text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded border border-transparent font-mono text-2xs"
              title={`Retrieved at rank ${source.n}`}
            >
              {source.n}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="flex min-w-0 items-baseline gap-1 text-xs">
                <span
                  className="text-foreground min-w-0 flex-1 truncate font-medium"
                  title={source.file}
                >
                  {source.file}
                </span>
                <span className="text-muted-foreground shrink-0">
                  · p. {source.page}
                </span>
              </p>
              <blockquote className="border-border text-foreground/80 mt-1 border-l-2 pl-2 text-xs break-words whitespace-pre-wrap">
                {source.excerpt}
              </blockquote>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
