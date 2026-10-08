"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { PageFrame } from "@/components/foundation/page-frame";
import { FadeIn } from "@/components/motion/primitives";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the application shell.
 *
 * Deliberately says nothing about what failed: no stack traces, no provider or
 * database detail. It reassures that work is not lost and offers the one action
 * that can actually help.
 */
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageFrame width="narrow">
      <FadeIn onMount className="mx-auto max-w-md pt-10">
        <div className="bg-card hairline rounded-xl border p-8 text-center">
          <span className="bg-warning-muted text-warning inline-flex size-10 items-center justify-center rounded-full">
            <TriangleAlert className="size-4.5" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-base font-medium">
            This view couldn&apos;t be displayed
          </h1>
          <p className="text-muted-foreground mt-2 text-sm text-pretty">
            Something went wrong while loading this screen. Nothing you entered
            was lost — try again, and if it keeps happening the workspace may
            need attention.
          </p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <Button onClick={reset} className="gap-2">
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Try again
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/ask">Back to Ask</Link>
            </Button>
          </div>
        </div>
      </FadeIn>
    </PageFrame>
  );
}
