"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "cn";

/**
 * Copy action with inline confirmation.
 *
 * Copies the answer's markdown source (what a reader would paste elsewhere).
 * Confirmation is inline rather than a toast: it cannot be missed next to the
 * button that produced it, and it needs no notification dependency.
 */
export function CopyButton({
  text,
  label = "Copy answer",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (permissions, insecure context): stay silent
      // rather than showing a failure the user cannot act on.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "text-muted-foreground hover:text-foreground gap-1.5 px-1.5",
        className,
      )}
    >
      {copied ? (
        <Check className="text-success size-3" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}
