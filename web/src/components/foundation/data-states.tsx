"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { ApiError } from "@/lib/api/errors";
import { DURATION, EASE } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

/**
 * Reusable non-AI states.
 *
 * These cover session and data loading only. The AI generation experience
 * (searching → generating → verifying) is a different component and belongs to
 * the chat pass; nothing here pretends to show model progress.
 *
 * Every state announces itself politely and never hides content behind an
 * entrance animation that depends on JavaScript.
 */

export function LoadingState({
  label = "Loading",
  hint,
  className,
}: {
  label?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-16 text-center",
        className,
      )}
    >
      <motion.span
        className="border-border border-t-primary inline-flex size-6 rounded-full border-2"
        animate={{ rotate: 360 }}
        transition={{ duration: 1.1, ease: EASE.standard, repeat: Infinity }}
        aria-hidden="true"
      >
        <LoaderCircle className="sr-only" />
      </motion.span>
      <p className="text-sm font-medium">{label}</p>
      {hint ? (
        <p className="text-muted-foreground max-w-sm text-xs text-pretty">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = "That didn't load",
  className,
}: {
  error: ApiError | null;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "bg-card hairline rounded-xl border p-6 text-center",
        className,
      )}
    >
      <span className="bg-warning-muted text-warning inline-flex size-9 items-center justify-center rounded-full">
        <TriangleAlert className="size-4" aria-hidden="true" />
      </span>
      <h2 className="mt-3 text-sm font-medium">{title}</h2>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm text-pretty">
        {error?.userMessage ?? "Something went wrong. Try again."}
      </p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-4 gap-2">
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Centred, full-height wrapper for session-level states. */
export function CenteredState({
  children,
  title,
  description,
  className,
}: {
  children?: ReactNode;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DURATION.slow, ease: EASE.decelerate }}
        className={cn("w-full max-w-sm text-center", className)}
      >
        <span
          className="bg-primary text-primary-foreground text-2xs mx-auto inline-flex size-8 items-center justify-center rounded-lg font-semibold"
          aria-hidden="true"
        >
          4i
        </span>
        <h1 className="mt-4 text-base font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground mt-2 text-sm text-pretty">
            {description}
          </p>
        ) : null}
        {children ? <div className="mt-6">{children}</div> : null}
      </motion.div>
    </div>
  );
}
