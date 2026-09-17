import {
  CircleDashed,
  SearchX,
  ShieldCheck,
  Split,
  type LucideIcon,
} from "lucide-react";

import { cn } from "cn";

export type { EvidenceState } from "@/lib/api/presentation";

import type { EvidenceState } from "@/lib/api/presentation";

/**
 * Evidence status.
 *
 * Translates the four evidence-gate outcomes into language a reader understands,
 * without exposing raw backend terminology ("SUPPORTED", "gate verdict") on the
 * surface. The visual tokens stay fixed per state so the same meaning always
 * looks the same across the product.
 *
 * Classes are written out per state (never interpolated) so Tailwind's scanner
 * sees them.
 */

type StateConfig = {
  label: string;
  description: string;
  icon: LucideIcon;
  chip: string;
  dot: string;
};

const STATES: Record<EvidenceState, StateConfig> = {
  supported: {
    label: "Supported",
    description: "Stated directly in the retrieved sources.",
    icon: ShieldCheck,
    chip: "border-success/25 bg-success-muted text-success",
    dot: "bg-success",
  },
  partial: {
    label: "Partly supported",
    description: "Some of this appears in the sources; the rest does not.",
    icon: CircleDashed,
    chip: "border-warning/30 bg-warning-muted text-warning",
    dot: "bg-warning",
  },
  conflicting: {
    label: "Sources disagree",
    description: "Retrieved passages contradict each other on this point.",
    icon: Split,
    chip: "border-conflict/25 bg-conflict-muted text-conflict",
    dot: "bg-conflict",
  },
  insufficient: {
    label: "Not enough evidence",
    description: "The documents do not cover this question.",
    icon: SearchX,
    chip: "border-border bg-neutral-state-muted text-muted-foreground",
    dot: "bg-neutral-state",
  },
};

export function evidenceStateConfig(state: EvidenceState) {
  return STATES[state];
}

/** Compact inline status chip: icon + label. */
export function EvidenceStatusBadge({
  state,
  showIcon = true,
  className,
}: {
  state: EvidenceState;
  showIcon?: boolean;
  className?: string;
}) {
  const config = STATES[state];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium whitespace-nowrap",
        config.chip,
        className,
      )}
      title={config.description}
    >
      {showIcon && <Icon className="size-3" aria-hidden="true" />}
      {config.label}
    </span>
  );
}

/** Bare dot for dense rows (lists, table cells, timeline rails). */
export function EvidenceStateDot({
  state,
  className,
}: {
  state: EvidenceState;
  className?: string;
}) {
  const config = STATES[state];
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", config.dot, className)}
      role="img"
      aria-label={config.label}
      title={config.description}
    />
  );
}

/**
 * Full status row with icon, label and explanation — used where the state needs
 * to be understood, not just noticed (answer header, evidence panel).
 */
export function EvidenceStatusRow({
  state,
  className,
}: {
  state: EvidenceState;
  className?: string;
}) {
  const config = STATES[state];
  const Icon = config.icon;
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span
        className={cn(
          "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full border",
          config.chip,
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{config.label}</p>
        <p className="text-muted-foreground text-sm text-pretty">
          {config.description}
        </p>
      </div>
    </div>
  );
}
