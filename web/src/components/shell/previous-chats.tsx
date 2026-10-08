"use client";

import { History, Plus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ConversationList } from "@/components/shell/conversation-list";
import { RailTooltip } from "@/components/shell/rail-tooltip";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Previous chats.
 *
 * A clear entry point to the real conversation history (PostgREST under RLS —
 * the same data the inline list reads; nothing local-only). The sidebar shows
 * the most recent conversations inline; this opens the complete history in a
 * drawer, which is the only way to reach it when the rail is collapsed.
 *
 * The drawer carries its own header: title on the left; "New question" and
 * "Close" as two comfortable, equally sized targets on the right, separated by
 * deliberate spacing so they never read as one control.
 */
export function PreviousChats({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);

  const trigger = collapsed ? (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Previous chats"
      className="text-muted-foreground hover:text-foreground"
    >
      <History className="size-4" aria-hidden="true" />
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-foreground w-full justify-start gap-2"
    >
      <History className="size-4" aria-hidden="true" />
      Previous chats
    </Button>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <RailTooltip label="Previous chats" enabled={collapsed}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
      </RailTooltip>

      <SheetContent
        side="left"
        className="w-72 gap-0 p-0"
        aria-label="Previous chats"
        showCloseButton={false}
      >
        <div className="hairline flex h-14 shrink-0 items-center gap-3 border-b px-3">
          <SheetTitle className="min-w-0 flex-1 truncate text-sm font-medium">
            Previous chats
          </SheetTitle>
          <div className="flex shrink-0 items-center gap-3">
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <Link
                href="/ask"
                aria-label="New question"
                onClick={() => setOpen(false)}
              >
                <Plus className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close previous chats"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>
        </div>
        <SheetDescription className="sr-only">
          Every conversation in this workspace, most recent first.
        </SheetDescription>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <ConversationList
            showHeader={false}
            onNavigate={() => setOpen(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
