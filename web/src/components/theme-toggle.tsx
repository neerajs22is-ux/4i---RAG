"use client";

import { motion } from "motion/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "cn";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

/** No-op subscription: the value only needs to differ between server and client. */
const subscribe = () => () => {};

/**
 * True after hydration, false during SSR.
 *
 * The resolved theme is unknown on the server, so the active indicator must not
 * render until the client takes over — otherwise the markup mismatches.
 * `useSyncExternalStore` gives that signal without a setState-in-effect.
 */
function useIsHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/** Three-way theme switch (light / system / dark). */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const hydrated = useIsHydrated();

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={cn(
        "bg-card/60 inline-flex items-center gap-0.5 rounded-full border p-0.5 backdrop-blur",
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = hydrated && theme === option.value;
        return (
          <Button
            key={option.value}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${option.label} theme`}
            aria-pressed={active}
            onClick={() => setTheme(option.value)}
            className={cn(
              "relative rounded-full transition-colors duration-[var(--duration-fast)]",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="theme-toggle-active"
                className="bg-accent absolute inset-0 rounded-full"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <motion.span
              className="relative"
              animate={{ scale: active ? 1.08 : 1 }}
              transition={{ duration: 0.13, ease: [0.2, 0, 0, 1] }}
            >
              <Icon className="size-3.5" aria-hidden="true" />
            </motion.span>
          </Button>
        );
      })}
    </div>
  );
}
