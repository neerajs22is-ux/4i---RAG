import type { CSSProperties } from "react";

import { DemoAnswer, DemoEvidence, DemoQuestion } from "@/components/site/answer-demo";
import { EntryAction } from "@/components/site/entry-action";

/**
 * Hero.
 *
 * The product is the hero: the headline and the answer surface sit side by
 * side (stacked on smaller viewports), and the answer demonstrably carries
 * its evidence. The copy column renders immediately; the demo card cascades
 * in question → answer → evidence with the same CSS reveal the application
 * uses for a fresh answer. Pure CSS, so it starts at first paint (nothing
 * waits on hydration), works without JavaScript, and settles instantly under
 * reduced motion. No other section animates.
 */

/** Delay index for the reveal cascade. */
function reveal(index: number): CSSProperties {
  return { "--reveal-i": index } as CSSProperties;
}

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative">
      <div
        aria-hidden="true"
        className="bg-[radial-gradient(ellipse_90%_70%_at_70%_-10%,color-mix(in_oklab,var(--accent)_75%,transparent),transparent_70%)] pointer-events-none absolute inset-0"
      />
      <div className="relative mx-auto grid w-full max-w-6xl gap-14 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-12 lg:pt-24 lg:pb-24">
        <div className="max-w-xl">
          <h1
            id="hero-heading"
            className="text-[clamp(2.25rem,4.6vw,3.4rem)] leading-[1.07] font-semibold tracking-[-0.025em] text-balance"
          >
            Ask your documents. Get answers with the evidence attached.
          </h1>
          <p className="text-muted-foreground mt-5 max-w-[54ch] text-base text-pretty">
            RAG&#8209;4i answers questions from the documents in your
            workspace, citing the passage behind every claim. When the
            documents don&apos;t cover a question, it says so.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <EntryAction size="lg" />
            <a
              href="#how-it-works"
              className="text-foreground decoration-border hover:decoration-foreground rounded-md text-sm font-medium underline underline-offset-4 transition-colors duration-[var(--duration-fast)]"
            >
              See how it works
            </a>
          </div>
          <p className="text-muted-foreground mt-3.5 text-xs">
            Accounts are provisioned by your workspace administrator.
          </p>
        </div>

        <div className="min-w-0">
          <div className="bg-background hairline site-reveal rounded-2xl border p-3.5 shadow-lg sm:p-5">
            <div style={reveal(0)}>
              <DemoQuestion />
            </div>
            <div className="mt-2.5" style={reveal(1)}>
              <DemoAnswer />
            </div>
            <div className="mt-2.5" style={reveal(2)}>
              <DemoEvidence />
            </div>
          </div>
          <p className="text-muted-foreground mt-3 text-center text-xs">
            An illustration of the answer surface. Your workspace answers from
            your own documents.
          </p>
        </div>
      </div>
    </section>
  );
}
