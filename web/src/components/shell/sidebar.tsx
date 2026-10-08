"use client";

import { motion, useReducedMotion } from "motion/react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { ConversationList } from "@/components/shell/conversation-list";
import { NotebookList } from "@/components/notebooks/notebook-list";
import { PreviousChats } from "@/components/shell/previous-chats";
import { RailTooltip } from "@/components/shell/rail-tooltip";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { WorkspaceMenu } from "@/components/shell/workspace-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getSidebarCollapsed,
  getSidebarServerSnapshot,
  setContextSidebarCollapsed,
  subscribeSidebar,
  toggleSidebar,
} from "@/lib/sidebar-state";
import { cn } from "cn";

const COLLAPSED_WIDTH = 56; // px — icon rail
const EXPANDED_WIDTH = 248; // px

/** A Space workspace route: `/notebooks/<id>` (the list page is not a Space). */
const SPACE_ROUTE = /^\/notebooks\/[^/]+\/?$/;

/**
 * Sidebar contents, shared by the desktop rail and the mobile drawer so both
 * stay identical by construction.
 *
 * Structure: identity · primary navigation · Spaces and conversation history ·
 * footer with the account control directly above the expand/collapse control.
 * The history area is intentionally an honest empty state — no invented
 * conversations.
 *
 * In the collapsed rail every interactive control is a label-less icon, so each
 * one carries an immediate tooltip (`RailTooltip`) and an accessible name.
 */
export function SidebarContent({
  collapsed = false,
  onNavigate,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Identity */}
      <div
        className={cn(
          "hairline flex h-14 shrink-0 items-center px-3",
          collapsed && "justify-center px-0",
        )}
      >
        <RailTooltip label="RAG-4i" enabled={collapsed}>
          <Link
            href="/ask"
            onClick={onNavigate}
            className="focus-visible:ring-ring/50 flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2"
          >
            <span
              className="bg-primary text-primary-foreground text-2xs inline-flex size-6 shrink-0 items-center justify-center rounded-md font-semibold"
              aria-hidden="true"
            >
              4i
            </span>
            {!collapsed ? (
              <>
                <span className="min-w-0 truncate text-sm font-medium tracking-tight">
                  RAG-4i
                </span>
                <Badge variant="secondary" className="font-mono text-2xs">
                  v1
                </Badge>
              </>
            ) : (
              <span className="sr-only">RAG-4i</span>
            )}
          </Link>
        </RailTooltip>
      </div>

      {/* Collapsed rail: the history drawer lives at the top, clear of the
          account and expand controls in the footer. */}
      {collapsed ? (
        <div className="flex shrink-0 flex-col items-center px-1.5 pt-2">
          <PreviousChats collapsed />
        </div>
      ) : null}

      {/* Primary navigation */}
      <div className={cn("shrink-0 px-2 pt-3", collapsed && "px-1.5")}>
        <SidebarNav collapsed={collapsed} onNavigate={onNavigate} />
        {!collapsed ? (
          <div className="mt-1.5">
            <PreviousChats />
          </div>
        ) : null}
      </div>

      {/* Spaces and conversation history — expanded only. The collapsed rail
          keeps just the interactive controls; no decorative icons. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          collapsed ? "px-1.5" : "hairline mt-4 border-t px-2 pt-3",
        )}
      >
        {!collapsed ? (
          <>
            <NotebookList />
            <div className="hairline mt-3 border-t pt-3">
              <ConversationList onNavigate={onNavigate} />
            </div>
          </>
        ) : null}
      </div>

      {/* Footer, both states: account directly above expand/collapse, at the
          absolute bottom. Collapsed, both controls are square and centred by
          the flex column, so alignment never depends on an offset. */}
      <div
        className={cn(
          "hairline flex shrink-0 flex-col border-t p-2",
          collapsed ? "items-center gap-1 px-1.5" : "gap-0.5",
        )}
      >
        <WorkspaceMenu collapsed={collapsed} />

        {onToggleCollapse ? (
          <RailTooltip label="Expand sidebar" enabled={collapsed}>
            <Button
              type="button"
              variant="ghost"
              size={collapsed ? "icon-sm" : "sm"}
              onClick={onToggleCollapse}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                collapsed ? "size-9" : "w-full justify-start",
              )}
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              ) : (
                <>
                  <PanelLeftClose className="size-4" aria-hidden="true" />
                  Collapse
                </>
              )}
            </Button>
          </RailTooltip>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Desktop rail.
 *
 * Width is animated so the content area visibly reflows (spatial relationship),
 * and the whole animation is skipped when the user prefers reduced motion.
 *
 * Inside a Space workspace (`/notebooks/<id>`) the rail collapses automatically
 * so the screen shows global navigation (condensed) + space context + chat,
 * instead of two competing left columns. That collapse is a route-scoped
 * override: the user's own preference is untouched, and expanding it here
 * affects only this visit.
 */
export function DesktopSidebar() {
  const pathname = usePathname();
  const inSpace = SPACE_ROUTE.test(pathname);
  const collapsed = useSyncExternalStore(
    subscribeSidebar,
    getSidebarCollapsed,
    getSidebarServerSnapshot,
  );
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    setContextSidebarCollapsed(inSpace ? true : null);
    // Re-runs on pathname changes, so moving between Spaces collapses again and
    // leaving a Space restores the stored preference.
  }, [pathname, inSpace]);

  return (
    <motion.aside
      aria-label="Sidebar"
      animate={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 380, damping: 34 }
      }
      className="bg-card/40 hairline hidden shrink-0 flex-col overflow-hidden border-r md:flex"
    >
      <SidebarContent
        collapsed={collapsed}
        onToggleCollapse={toggleSidebar}
      />
    </motion.aside>
  );
}
