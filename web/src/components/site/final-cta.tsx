import { EntryAction } from "@/components/site/entry-action";

/**
 * Closing call to action.
 *
 * One action, honestly described: accounts are provisioned by a workspace
 * administrator, so the page does not promise a signup flow that does not
 * exist.
 */
export function FinalCta() {
  return (
    <section
      aria-labelledby="cta-heading"
      className="hairline border-t"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center sm:px-6 sm:py-20 lg:py-24">
        <h2
          id="cta-heading"
          className="mx-auto max-w-[24ch] text-[clamp(1.75rem,3vw,2.25rem)] leading-tight font-semibold tracking-[-0.02em] text-balance"
        >
          Put it to work on your documents.
        </h2>
        <p className="text-muted-foreground mx-auto mt-4 max-w-[52ch] text-base text-pretty">
          Sign in to open your workspace: upload a document, ask the first
          question, and read the answer with its evidence.
        </p>
        <div className="mt-8">
          <EntryAction size="lg" />
          <p className="text-muted-foreground mt-3.5 text-xs">
            Accounts are provisioned by your workspace administrator.
          </p>
        </div>
      </div>
    </section>
  );
}
