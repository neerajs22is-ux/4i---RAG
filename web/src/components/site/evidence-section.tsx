import {
  EvidenceStatusBadge,
  evidenceStateConfig,
  type EvidenceState,
} from "@/components/foundation/evidence-status";
import { MarkerLinkDemo, RefusalDemo } from "@/components/site/evidence-figure";

/**
 * Evidence section.
 *
 * The honest-answer system: a refusal and a cited answer shown as real
 * product fragments, and the four states with the product's own descriptions.
 * Nothing here is a claim about accuracy; it is a description of what the
 * interface does with an answer it cannot fully back.
 */

const STATES: EvidenceState[] = [
  "supported",
  "partial",
  "conflicting",
  "insufficient",
];

export function EvidenceSection() {
  return (
    <section
      id="evidence"
      aria-labelledby="evidence-heading"
      className="hairline border-t"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-16">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2
              id="evidence-heading"
              className="text-[clamp(1.75rem,3vw,2.25rem)] leading-tight font-semibold tracking-[-0.02em] text-balance"
            >
              Every answer shows where it came from.
            </h2>
            <p className="text-muted-foreground mt-4 max-w-[48ch] text-base text-pretty">
              Citations open the exact passage a claim was drawn from, with its
              document and page. You decide whether the evidence holds before
              you rely on the answer.
            </p>
            <p className="text-muted-foreground mt-4 max-w-[48ch] text-base text-pretty">
              And when the retrieved passages don&apos;t tell the whole story,
              RAG&#8209;4i labels the answer instead of smoothing over the gap.
            </p>
          </div>

          <div className="min-w-0">
            <div className="space-y-4">
              <RefusalDemo />
              <MarkerLinkDemo />
            </div>
            <p className="text-muted-foreground mt-3 text-center text-xs">
              Illustrations of the answer surface. Your workspace answers from
              your own documents.
            </p>
          </div>
        </div>

        <dl className="hairline mt-14 grid gap-x-10 gap-y-7 border-t pt-10 sm:grid-cols-2 lg:grid-cols-4">
          {STATES.map((state) => {
            const config = evidenceStateConfig(state);
            return (
              <div key={state}>
                <dt>
                  <EvidenceStatusBadge state={state} />
                </dt>
                <dd className="text-muted-foreground mt-2.5 max-w-[40ch] text-sm text-pretty">
                  {config.description}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}
