import { EntryAction } from "@/components/site/entry-action";

const LINKS = [
  { href: "#evidence", label: "Evidence" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#security", label: "Security" },
];

export function SiteFooter() {
  return (
    <footer className="hairline border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className="bg-primary text-primary-foreground text-2xs inline-flex size-6 shrink-0 items-center justify-center rounded-md font-semibold"
            aria-hidden="true"
          >
            4i
          </span>
          <div>
            <p className="text-sm font-medium tracking-tight">RAG-4i</p>
            <p className="text-muted-foreground text-xs">
              Grounded answers for professional teams.
            </p>
          </div>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-md text-xs transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2"
            >
              {link.label}
            </a>
          ))}
          <EntryAction text />
        </nav>
      </div>
      <div className="hairline border-t">
        <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-4 text-2xs sm:px-6">
          © 2026 RAG-4i
        </p>
      </div>
    </footer>
  );
}
