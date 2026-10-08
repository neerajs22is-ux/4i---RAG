import { IsolationFigure } from "@/components/site/isolation-figure";

/**
 * Security and trust.
 *
 * Only properties that are genuinely implemented are stated (see
 * ARCHITECTURE.md Part 1): database-enforced tenancy, private storage,
 * server-side provider calls, and live membership checks. The figure draws
 * the implemented isolation mechanism; no certification, guarantee or
 * compliance claim is made.
 */

const ITEMS = [
  {
    title: "Workspace isolation in the database",
    body: "Documents, passages and conversations carry the workspace they belong to, and row-level security checks membership in the database on every read.",
  },
  {
    title: "Private document storage",
    body: "Files live in a private, workspace-scoped store. There are no public document URLs.",
  },
  {
    title: "Models stay on the server",
    body: "Retrieval and generation run server-side. The browser never holds a model provider key, and it never calls a provider directly.",
  },
  {
    title: "Access follows membership",
    body: "Only members of a workspace can reach its documents, and the check runs on every request. Removing someone from a workspace takes effect immediately.",
  },
];

export function SecuritySection() {
  return (
    <section
      id="security"
      aria-labelledby="security-heading"
      className="hairline border-t"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
        <h2
          id="security-heading"
          className="text-[clamp(1.75rem,3vw,2.25rem)] leading-tight font-semibold tracking-[-0.02em] text-balance"
        >
          Built for work you cannot email around.
        </h2>
        <p className="text-muted-foreground mt-4 max-w-[56ch] text-base text-pretty">
          Client documents deserve more than a shared drive. These are the
          boundaries the product is built on, stated as they are implemented.
        </p>

        <dl className="mt-10 grid gap-x-14 gap-y-8 sm:grid-cols-2">
          {ITEMS.map((item) => (
            <div key={item.title} className="hairline border-t pt-5">
              <dt className="text-base font-medium tracking-tight">
                {item.title}
              </dt>
              <dd className="text-muted-foreground mt-2 max-w-[48ch] text-sm leading-relaxed text-pretty">
                {item.body}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mx-auto mt-14 w-full max-w-3xl">
          <IsolationFigure />
        </div>
      </div>
    </section>
  );
}
