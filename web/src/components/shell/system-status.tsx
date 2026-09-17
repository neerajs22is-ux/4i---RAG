"use client";

import { Activity, RotateCcw } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";

import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { relativeTime } from "@/lib/format";
import {
  getHealthServerSnapshot,
  getHealthSnapshot,
  runHealthChecks,
  subscribeHealth,
  SUBSYSTEMS,
  type HealthStatus,
  type HealthSubsystem,
} from "@/lib/health";
import { cn } from "cn";

/**
 * System status.
 *
 * A quiet dot in the top bar that opens the real health picture. Every value
 * comes from `lib/health.ts` — live probes and the outcome of the user's own
 * requests — never from a simulated check.
 *
 * Recovery is deliberately narrow: "Retry" re-runs one probe for one
 * subsystem. There is no reset, no clearing of data, and no attempt to repair
 * anything that cannot be repaired from the browser; those are labelled
 * "Needs attention" instead.
 */

const DOT: Record<HealthStatus, string> = {
  healthy: "bg-success",
  problem: "bg-destructive",
  unknown: "bg-warning",
};

const LABEL: Record<HealthStatus, string> = {
  healthy: "Healthy",
  problem: "Problem",
  unknown: "Unknown",
};

const TEXT: Record<HealthStatus, string> = {
  healthy: "text-success",
  problem: "text-destructive",
  unknown: "text-warning",
};

/**
 * Subsystems with a known, safe, targeted recovery: re-running that single
 * read-only probe. Generation cannot be restarted from a browser, so it never
 * offers a Fix action.
 */
const RETRYABLE: HealthSubsystem[] = ["backend", "database", "embeddings"];

export function SystemStatus() {
  const { activeWorkspace } = useSession();
  const health = useSyncExternalStore(
    subscribeHealth,
    getHealthSnapshot,
    getHealthServerSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const tenantId = activeWorkspace?.tenantId ?? null;

  const check = useCallback(
    (force: boolean) => {
      setChecking(true);
      void runHealthChecks({ tenantId, force }).finally(() =>
        setChecking(false),
      );
    },
    [tenantId],
  );

  const statuses = SUBSYSTEMS.map((s) => health[s.id].status);
  const overall: HealthStatus = statuses.includes("problem")
    ? "problem"
    : statuses.includes("unknown")
      ? "unknown"
      : "healthy";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Opening the panel triggers a check, but only once the probes are
        // actually due (TTL) — see `runHealthChecks`.
        if (next) check(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`System status: ${LABEL[overall]}`}
          className="text-muted-foreground hover:text-foreground relative"
        >
          <Activity className="size-4" aria-hidden="true" />
          <span
            className={cn(
              "ring-background absolute right-1 bottom-1 size-1.5 rounded-full ring-2",
              DOT[overall],
            )}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-72 p-1.5" aria-label="System status">
        <div className="flex items-center justify-between px-2 py-1.5">
          <p className="text-xs font-medium">System status</p>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => check(true)}
            disabled={checking}
            aria-label="Re-check now"
            className="text-muted-foreground hover:text-foreground"
          >
            <RotateCcw
              className={cn("size-3", checking && "animate-spin")}
              aria-hidden="true"
            />
          </Button>
        </div>

        <Separator className="my-1" />

        <ul>
          {SUBSYSTEMS.map((subsystem) => {
            const entry = health[subsystem.id];
            const retryable = RETRYABLE.includes(subsystem.id);
            return (
              <li key={subsystem.id} className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      DOT[entry.status],
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-xs font-medium">
                    {subsystem.label}
                  </span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 text-2xs font-medium",
                      TEXT[entry.status],
                    )}
                  >
                    {checking && entry.status === "unknown"
                      ? "Checking…"
                      : LABEL[entry.status]}
                  </span>
                </div>
                <p className="text-muted-foreground/80 mt-0.5 pl-3.5 text-2xs text-pretty">
                  {entry.note}
                  {entry.at && entry.status !== "unknown"
                    ? ` · ${relativeTime(new Date(entry.at).toISOString())}`
                    : ""}
                </p>
                {entry.status === "problem" ? (
                  retryable ? (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => check(true)}
                      disabled={checking}
                      className="mt-1.5 ml-3.5 gap-1"
                    >
                      <RotateCcw className="size-3" aria-hidden="true" />
                      Retry
                    </Button>
                  ) : (
                    <p className="text-warning mt-0.5 pl-3.5 text-2xs">
                      Needs attention — no safe automatic fix
                    </p>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>

        <Separator className="my-1" />
        <p className="text-muted-foreground/70 px-2 py-1.5 text-2xs text-pretty">
          Checks are read-only. Nothing is reset or restarted.
        </p>
      </PopoverContent>
    </Popover>
  );
}
