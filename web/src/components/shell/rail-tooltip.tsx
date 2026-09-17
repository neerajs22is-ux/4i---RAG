"use client";

import type { ReactElement } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Tooltip for the collapsed sidebar rail.
 *
 * The rail hides text labels, so each interactive control carries its name in a
 * tooltip. Radix opens it on hover **and** on keyboard focus, and the delay is
 * zero so the label appears immediately rather than after the app's shared
 * 200 ms delay. When the rail is expanded the visible label is the label, so no
 * tooltip is rendered at all.
 */
export function RailTooltip({
  label,
  enabled,
  side = "right",
  children,
}: {
  label: string;
  enabled: boolean;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
}) {
  if (!enabled) return children;

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
