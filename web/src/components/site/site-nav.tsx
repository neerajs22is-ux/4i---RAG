import Link from "next/link";

import { EntryAction } from "@/components/site/entry-action";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Public navigation.
 *
 * One quiet row: identity, three in-page sections, the theme control and the
 * single real entry action. The section links collapse on narrow viewports —
 * the page reads top to bottom, so nothing is trapped behind a menu.
 */

const LINKS = [
  { href: "#evidence", label: "Evidence" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#security", label: "Security" },
];

export function SiteNav() {
  return (
    <header className="bg-background/85 hairline sticky top-0 z-40 border-b backdrop-blur">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6"
      >
        <Link
          href="/"
          className="focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2"
        >
          <span
            className="bg-primary text-primary-foreground text-2xs inline-flex size-6 shrink-0 items-center justify-center rounded-md font-semibold"
            aria-hidden="true"
          >
            4i
          </span>
          <span className="text-sm font-medium tracking-tight">RAG-4i</span>
        </Link>

        <div className="ml-4 hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle className="hidden sm:inline-flex" />
          <EntryAction size="sm" />
        </div>
      </nav>
    </header>
  );
}
