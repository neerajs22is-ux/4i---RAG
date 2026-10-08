"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

/**
 * The single entry action on the public page.
 *
 * Signed out it opens the sign-in screen ("Sign in"); signed in it opens the
 * workspace ("Open workspace"). The destination is the same either way
 * (`/ask`; the workspace's auth gate resolves which screen applies), but the
 * label tells the truth for each visitor. Signed-in visitors are deliberately
 * not redirected away from the landing — the page stays reachable and
 * linkable for everyone.
 *
 * While the session is still resolving the signed-out label renders (the
 * landing itself never depends on auth state).
 */
export function EntryAction({
  size = "lg",
  text = false,
  className,
}: {
  /** Button size; ignored when `text` is set. */
  size?: "sm" | "lg";
  /** Render as a text link (footer) instead of a button. */
  text?: boolean;
  className?: string;
}) {
  const { status } = useSession();
  const signedIn = status === "signed-in";

  if (text) {
    return (
      <Link
        href="/ask"
        className={cn(
          "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-md text-xs transition-colors duration-[var(--duration-fast)] outline-none focus-visible:ring-2",
          className,
        )}
      >
        {signedIn ? "Open workspace" : "Sign in"}
      </Link>
    );
  }

  return (
    <Button
      asChild
      size={size}
      className={cn("gap-2 active:scale-[0.98]", className)}
    >
      <Link href="/ask">
        {signedIn ? "Open workspace" : "Sign in to your workspace"}
        {size === "lg" ? (
          <ArrowRight className="size-4" aria-hidden="true" />
        ) : null}
      </Link>
    </Button>
  );
}
