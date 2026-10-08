import { ArrowRight, SearchX } from "lucide-react";
import Link from "next/link";

import { FadeIn } from "@/components/motion/primitives";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

/**
 * Not found.
 *
 * Rendered outside the app shell (the route does not exist), so it carries its
 * own minimal identity row. Understated on purpose: no oversized 404, no
 * illustration — just what happened and a way back.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-2.5">
          <span
            className="bg-primary text-primary-foreground text-2xs inline-flex size-6 items-center justify-center rounded-md font-semibold"
            aria-hidden="true"
          >
            4i
          </span>
          <span className="text-sm font-medium tracking-tight">RAG-4i</span>
        </div>
        <ThemeToggle />
      </header>

      <main
        id="main"
        className="flex flex-1 items-center justify-center px-6 pb-20"
      >
        <FadeIn onMount className="mx-auto w-full max-w-sm text-center">
          <span className="bg-muted text-muted-foreground inline-flex size-10 items-center justify-center rounded-full">
            <SearchX className="size-4.5" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-lg font-semibold tracking-tight">
            That page doesn&apos;t exist
          </h1>
          <p className="text-muted-foreground mt-2 text-sm text-pretty">
            The link may be out of date, or the page may have moved.
          </p>
          <Button asChild className="mt-6 gap-2">
            <Link href="/">
              Back to home
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </FadeIn>
      </main>
    </div>
  );
}
