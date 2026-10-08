import { Check } from "lucide-react";

/**
 * Spaces section.
 *
 * Scoping, demonstrated with the product's own scope header and source rows.
 * The fragment is the real vocabulary ("Answering from N of M sources
 * included"); the sources are illustrative.
 */

const SOURCES = [
  { name: "Year-End Procedures.pdf", included: true },
  { name: "Fixed Assets Advisory Note.pdf", included: true },
  { name: "Client Onboarding Checklist.pdf", included: true },
  { name: "Firm Newsletter — March.pdf", included: false },
  { name: "Archive — Old Templates.pdf", included: false },
];

export function SpacesSection() {
  return (
    <section aria-labelledby="spaces-heading" className="hairline border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-16 lg:py-24">
        <div className="order-2 lg:order-1">
          <div className="bg-background hairline max-w-md rounded-2xl border p-4 shadow-sm sm:p-5">
            <p className="text-foreground text-sm font-medium">Year-end close</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Answering from 3 of 5 sources included
            </p>
            <ul className="divide-border/70 mt-3 divide-y">
              {SOURCES.map((source) => (
                <li key={source.name} className="flex items-center gap-2.5 py-2">
                  <span
                    className={
                      source.included
                        ? "bg-primary text-primary-foreground inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]"
                        : "border-border inline-flex size-4 shrink-0 rounded-[4px] border"
                    }
                    aria-hidden="true"
                  >
                    {source.included ? <Check className="size-3" /> : null}
                  </span>
                  <span
                    className={
                      source.included
                        ? "text-foreground min-w-0 flex-1 truncate text-xs"
                        : "text-muted-foreground min-w-0 flex-1 truncate text-xs"
                    }
                    title={source.name}
                  >
                    {source.name}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="order-1 lg:order-2 lg:pt-2">
          <h2
            id="spaces-heading"
            className="text-[clamp(1.75rem,3vw,2.25rem)] leading-tight font-semibold tracking-[-0.02em] text-balance"
          >
            Keep answers inside the matter.
          </h2>
          <p className="text-muted-foreground mt-4 max-w-[48ch] text-base text-pretty">
            A Space is a set of sources you choose. Ask inside it and retrieval
            stays inside it, so the answer cannot drift into documents the
            matter does not touch.
          </p>
          <p className="text-muted-foreground mt-4 max-w-[48ch] text-base text-pretty">
            Switching a source on or off changes the scope of every following
            question; nothing else moves.
          </p>
        </div>
      </div>
    </section>
  );
}
