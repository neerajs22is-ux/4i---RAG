"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "cn"

/**
 * Checkbox.
 *
 * Used for source selection. Radix supplies the accessible behaviour (space to
 * toggle, `aria-checked` including the indeterminate state, focus ring via the
 * shared `outline-ring` base layer), so selection is operable from the keyboard
 * and announced correctly — not just clickable.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-input size-4 shrink-0 rounded-[4px] border shadow-xs transition-[color,box-shadow] outline-none",
        "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3.5" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
