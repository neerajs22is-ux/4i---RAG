/**
 * How it works.
 *
 * A real sequence, so it is numbered. Four steps, kept to what the product
 * actually does — upload and indexing, plain-language questions, retrieval
 * with an evidence check, and answers that carry their sources or refuse.
 */

const STEPS = [
  {
    title: "Add your documents",
    body: "Upload the PDFs your team works from. Each document is parsed page by page and indexed inside your workspace.",
  },
  {
    title: "Ask in plain language",
    body: "Type the question the way you would ask a colleague. No query syntax, no keywords to guess.",
  },
  {
    title: "RAG-4i searches before it answers",
    body: "Every question retrieves passages from your workspace's documents, by meaning and by term, and the retrieved evidence is checked before any wording is produced.",
  },
  {
    title: "Read the answer, open its evidence",
    body: "Answers arrive with citations attached. Open any marker to read the passage behind it, or get a plain refusal when the documents do not cover the question.",
  },
];

export function StepsSection() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="steps-heading"
      className="hairline border-t"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-16 lg:py-24">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <h2
            id="steps-heading"
            className="text-[clamp(1.75rem,3vw,2.25rem)] leading-tight font-semibold tracking-[-0.02em] text-balance"
          >
            From a folder of PDFs to a checked answer.
          </h2>
          <p className="text-muted-foreground mt-4 max-w-[44ch] text-base text-pretty">
            Four steps, no configuration. The same pipeline runs for every
            question, and it either finds the evidence or tells you it did not.
          </p>
        </div>

        <ol className="divide-border/70 divide-y">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-5 py-6 first:pt-0 last:pb-0">
              <span
                className="text-primary-strong font-mono text-sm leading-6"
                aria-hidden="true"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="text-base font-semibold tracking-tight">
                  {step.title}
                </h3>
                <p className="text-muted-foreground mt-1.5 max-w-[52ch] text-sm leading-relaxed text-pretty">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
