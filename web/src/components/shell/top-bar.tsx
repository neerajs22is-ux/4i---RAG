"use client";

import { motion } from "motion/react";
import { usePathname } from "next/navigation";

import { MobileNav } from "@/components/shell/mobile-nav";
import { activeNavItem } from "@/components/shell/nav-config";
import { SystemStatus } from "@/components/shell/system-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { DURATION, EASE } from "@/lib/motion";

/**
 * Route-change feedback.
 *
 * A one-shot accent sweep under the top bar, keyed by path. Decorative only
 * (`aria-hidden`) and never hides content — navigation still feels immediate
 * even if the animation never runs.
 */
function RouteSheen({ pathname }: { pathname: string }) {
  return (
    <motion.span
      key={pathname}
      aria-hidden="true"
      className="bg-primary absolute inset-x-0 bottom-0 h-px origin-left"
      initial={{ scaleX: 0, opacity: 0.8 }}
      animate={{ scaleX: 1, opacity: 0 }}
      transition={{ duration: DURATION.slow, ease: EASE.decelerate }}
    />
  );
}

/**
 * Shell top bar.
 *
 * Deliberately thin: it answers "where am I" and hosts the mobile menu and the
 * theme control. No search field, no notifications, no account dropdown —
 * nothing the product cannot yet back with real behaviour.
 */
export function TopBar() {
  const pathname = usePathname();
  const current = activeNavItem(pathname);

  return (
    <header className="bg-background/80 hairline sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 overflow-hidden border-b px-3 backdrop-blur sm:px-5">
      <MobileNav />

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="text-muted-foreground hidden shrink-0 sm:inline">
            Workspace
          </span>
          <span
            className="text-muted-foreground/50 hidden shrink-0 sm:inline"
            aria-hidden="true"
          >
            /
          </span>
          <span className="min-w-0 truncate font-medium">
            {current?.label ?? "Not found"}
          </span>
        </p>
      </nav>

      <SystemStatus />
      <ThemeToggle />
      <RouteSheen pathname={pathname} />
    </header>
  );
}
