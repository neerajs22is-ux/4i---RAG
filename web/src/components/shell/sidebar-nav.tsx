"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { isNavItemActive, NAV_ITEMS } from "@/components/shell/nav-config";
import { RailTooltip } from "@/components/shell/rail-tooltip";
import { cn } from "cn";

/**
 * Primary navigation list.
 *
 * Active state is communicated three ways, never colour alone:
 * an animated shared-indicator surface that travels between items, a weight
 * change on the label, and `aria-current="page"` for assistive technology.
 *
 * The indicator is a single moving element (`layoutId`) rather than one
 * per-item animation, so the eye tracks location instead of seeing three
 * independent fades.
 */
export function SidebarNav({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active = isNavItemActive(pathname, item.href);
        const Icon = item.icon;

        const link = (
          <Link
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-lg py-2 text-sm outline-none",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:ring-ring/50 focus-visible:ring-2",
              collapsed ? "justify-center px-0" : "px-2.5",
              active
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active ? (
              <motion.span
                layoutId="sidebar-active"
                className="bg-accent absolute inset-0 rounded-lg"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            ) : null}
            {!active ? (
              <span className="bg-accent/60 absolute inset-0 rounded-lg opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100" />
            ) : null}
            <Icon
              aria-hidden="true"
              className={cn(
                "relative size-4 shrink-0 transition-transform duration-[var(--duration-fast)]",
                active ? "text-primary-strong" : "group-hover:translate-x-0.5",
              )}
            />
            {!collapsed ? (
              <span className="relative min-w-0 truncate">{item.label}</span>
            ) : null}
          </Link>
        );

        // Collapsed rail hides labels, so the tooltip carries the name.
        return collapsed ? (
          <RailTooltip key={item.href} label={item.label} enabled>
            {link}
          </RailTooltip>
        ) : (
          <div key={item.href}>{link}</div>
        );
      })}
    </nav>
  );
}
