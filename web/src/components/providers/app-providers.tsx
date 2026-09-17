"use client";

import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import { SessionProvider } from "@/components/providers/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { transition } from "@/lib/motion";

/**
 * App-level providers.
 *
 * - `ThemeProvider` (next-themes) drives the `.dark` class for class-based dark
 *   mode, with system preference as the default.
 * - `SessionProvider` resolves the Supabase session and the active workspace
 *   once for the whole app.
 * - `MotionConfig reducedMotion="user"` makes every Motion primitive honour
 *   `prefers-reduced-motion` automatically: transform animations are skipped,
 *   opacity transitions still play so content never appears to "pop".
 * - `TooltipProvider` is required by Radix tooltips; one provider for the whole
 *   app keeps a single shared delay and open-state.
 * - A default transition keeps ad-hoc Motion usage on the same rhythm.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <SessionProvider>
        <MotionConfig
          reducedMotion="user"
          transition={transition("normal", "standard")}
        >
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </MotionConfig>
      </SessionProvider>
    </ThemeProvider>
  );
}
