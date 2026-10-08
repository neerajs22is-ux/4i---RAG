"use client";

import { Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listConversations } from "@/lib/api/conversations";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import type { ConversationRow } from "@/lib/api/types";
import {
  getConversationRevision,
  getConversationRevisionServer,
  subscribeConversations,
} from "@/lib/chat/conversations-store";
import { relativeTime, truncate } from "@/lib/format";
import { cn } from "cn";

/**
 * Conversation history, from real data.
 *
 * Reads `conversations` through PostgREST under RLS — the same authorization
 * boundary as everything else. The chat bumps a revision counter after the
 * first successful answer in a new conversation, which re-reads this list so a
 * brand-new conversation appears immediately, without polling.
 *
 * States are explicit: loading (skeletons), empty (honest copy), error
 * (retryable). No placeholder conversations are ever shown.
 */
export function ConversationList({
  onNavigate,
  showHeader = true,
}: {
  onNavigate?: () => void;
  /**
   * Hide the inline "Recent" header when the host renders its own
   * (the Previous chats drawer has a full header). Defaults to shown.
   */
  showHeader?: boolean;
}) {
  const { activeWorkspace } = useSession();
  const pathname = usePathname();
  const revision = useSyncExternalStore(
    subscribeConversations,
    getConversationRevision,
    getConversationRevisionServer,
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; items: ConversationRow[] }
    | { kind: "error"; error: ApiError }
  >({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!activeWorkspace) return;
    let cancelled = false;
    listConversations(activeWorkspace.tenantId)
      .then((items) => {
        if (!cancelled) setState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            error: normalizeApiError(error, "conversations"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace, reloadToken, revision]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setReloadToken((n) => n + 1);
  }, []);

  return (
    <div className="min-h-0">
      {showHeader ? (
        <div className="flex items-center justify-between px-1.5 pb-2">
          <p className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
            Recent
          </p>
          <Button
            asChild
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
          >
            <Link href="/ask" aria-label="New question" onClick={onNavigate}>
              <Plus className="size-3" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <div className="space-y-1.5 px-1.5" aria-busy="true">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-6 w-3/5" />
          <span className="sr-only" role="status">
            Loading conversations
          </span>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="hairline rounded-lg border border-dashed px-3 py-3">
          <p className="text-muted-foreground text-2xs">
            {state.error.userMessage}
          </p>
          <Button
            variant="ghost"
            size="xs"
            onClick={retry}
            className="text-muted-foreground mt-2 gap-1.5 px-0"
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}

      {state.kind === "ready" && state.items.length === 0 ? (
        <div className="hairline rounded-lg border border-dashed px-3 py-4">
          <p className="text-muted-foreground text-2xs">No conversations yet</p>
          <p className="text-muted-foreground/70 mt-1 text-2xs text-pretty">
            Your questions will appear here once you start asking.
          </p>
        </div>
      ) : null}

      {state.kind === "ready" && state.items.length > 0 ? (
        <ul className="space-y-0.5">
          {state.items.map((item) => {
            const href = `/c/${item.id}`;
            const active = pathname === href;
            return (
              <li key={item.id}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-1.5 py-1.5 text-xs transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="block min-w-0 truncate">
                    {item.title ? truncate(item.title, 46) : "Untitled question"}
                  </span>
                  <span className="text-muted-foreground/70 block text-2xs">
                    {relativeTime(item.updated_at)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
