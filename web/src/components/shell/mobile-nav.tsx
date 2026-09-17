"use client";

import { Menu } from "lucide-react";
import { useState } from "react";

import { SidebarContent } from "@/components/shell/sidebar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Mobile navigation.
 *
 * Below `md` the sidebar becomes a left drawer, reusing the exact same
 * `SidebarContent`. Radix handles the focus trap, Escape, overlay click and
 * focus return; navigating closes the drawer explicitly (no pathname effect).
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label="Open navigation"
        >
          <Menu className="size-4" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-64 gap-0 p-0"
        aria-label="Navigation"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>
            Primary navigation and conversation history.
          </SheetDescription>
        </SheetHeader>
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
