import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "cn";

/**
 * Content frame.
 *
 * The shell owns the viewport (fixed sidebar + fixed top bar); each page owns
 * its own scrolling content. These components keep the horizontal rhythm and
 * page header semantics identical across surfaces so new pages (conversation,
 * documents, settings, evidence) do not re-invent spacing.
 */

export function PageFrame({
  children,
  width = "default",
  className,
}: {
  children: ReactNode;
  /** `narrow` suits reading surfaces; `wide` suits tables and panels. */
  width?: "narrow" | "default" | "wide";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-5 py-8 sm:px-8 lg:py-12",
        width === "narrow" && "max-w-3xl",
        width === "default" && "max-w-5xl",
        width === "wide" && "max-w-7xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? (
          <p className="text-2xs text-muted-foreground font-medium tracking-wide uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground max-w-2xl text-sm text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * Empty state.
 *
 * Used wherever a surface has no data yet. Deliberately states what will appear
 * rather than showing invented content.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed px-6 py-14 text-center",
        className,
      )}
    >
      <span className="bg-muted text-muted-foreground inline-flex size-10 items-center justify-center rounded-full">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-sm font-medium">{title}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-sm text-sm text-pretty">
        {description}
      </p>
      {children ? <div className="mt-5">{children}</div> : null}
    </div>
  );
}
