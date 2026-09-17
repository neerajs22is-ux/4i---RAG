"use client";

import { Check, ChevronsUpDown, LogOut } from "lucide-react";
import { useState } from "react";

import { useSession } from "@/components/providers/session-provider";
import { RailTooltip } from "@/components/shell/rail-tooltip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "cn";

/**
 * Workspace and account control.
 *
 * The active workspace is a real authorization scope: it is sent as `tenant_id`
 * on every API call and enforced by RLS on every read. Switching workspaces is
 * therefore a deliberate action, not cosmetic — the switcher only appears when
 * the account actually belongs to more than one.
 */
export function WorkspaceMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { user, workspaces, activeWorkspace, setActiveWorkspace, signOut } =
    useSession();
  const [signingOut, setSigningOut] = useState(false);

  const email = user?.email ?? "Signed in";
  const role = activeWorkspace?.role ?? null;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  const trigger = (
    <Button
      variant="ghost"
      aria-label={
        collapsed
          ? `Account menu. Workspace: ${activeWorkspace?.name ?? "none"}`
          : undefined
      }
      className={cn(
        "h-auto w-full justify-start gap-2 px-2 py-1.5 text-left",
        collapsed && "size-9 shrink-0 justify-center p-0",
      )}
    >
      <span
        className="bg-secondary text-secondary-foreground text-2xs inline-flex size-5 shrink-0 items-center justify-center rounded font-medium uppercase"
        aria-hidden="true"
      >
        {(activeWorkspace?.name ?? "?").slice(0, 1)}
      </span>
      {!collapsed ? (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-2xs font-medium">
              {activeWorkspace?.name ?? "No workspace"}
            </span>
            <span className="text-muted-foreground block truncate text-2xs">
              {email}
            </span>
          </span>
          <ChevronsUpDown className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
        </>
      ) : null}
    </Button>
  );

  return (
    <Popover>
      <RailTooltip label="Account" enabled={collapsed}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </RailTooltip>
      <PopoverContent align="start" side="top" className="w-64 p-1.5">
        <div className="px-2 py-1.5">
          <p className="truncate text-xs font-medium">{email}</p>
          {role ? (
            <p className="text-muted-foreground text-2xs capitalize">
              {role} in {activeWorkspace?.name}
            </p>
          ) : null}
        </div>

        {workspaces.length > 1 ? (
          <>
            <Separator className="my-1" />
            <p className="text-muted-foreground px-2 py-1 text-2xs font-medium tracking-wide uppercase">
              Workspaces
            </p>
            <ul>
              {workspaces.map((w) => {
                const active = w.tenantId === activeWorkspace?.tenantId;
                return (
                  <li key={w.tenantId}>
                    <button
                      type="button"
                      onClick={() => setActiveWorkspace(w.tenantId)}
                      className={cn(
                        "hover:bg-accent focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2",
                        active && "text-foreground font-medium",
                      )}
                    >
                      <Check
                        className={cn("size-3 shrink-0", !active && "opacity-0")}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 truncate">{w.name}</span>
                      <span className="text-muted-foreground ml-auto text-2xs capitalize">
                        {w.role}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        <Separator className="my-1" />
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="hover:bg-accent focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 disabled:opacity-50"
        >
          <LogOut className="size-3 shrink-0" aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </PopoverContent>
    </Popover>
  );
}
