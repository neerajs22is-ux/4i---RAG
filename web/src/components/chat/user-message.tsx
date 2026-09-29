"use client";

import { motion } from "motion/react";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DURATION, EASE } from "@/lib/motion";
import { cn } from "cn";

/**
 * User message.
 *
 * Deliberately compact and visually secondary to the answer: a tinted surface,
 * no card chrome. The question is preserved verbatim (whitespace included) so
 * it reads as the user wrote it.
 *
 * Each message carries one quiet Edit control (always visible — hover does
 * not exist on touch screens). Editing reuses the Composer inline; the host
 * disables the control while another edit or request is in flight.
 */
export function UserMessage({
  content,
  entrance = false,
  onEdit,
  editDisabled = false,
}: {
  content: string;
  entrance?: boolean;
  /** Enter edit mode for this message. Absent when editing is unavailable. */
  onEdit?: () => void;
  editDisabled?: boolean;
}) {
  const body = (
      <p className="text-base leading-relaxed break-words whitespace-pre-wrap">
      {content}
    </p>
  );

  const className =
    "bg-secondary/70 hairline rounded-xl border px-3.5 py-2.5";

  const bubble = !entrance ? (
    <div className={className}>{body}</div>
  ) : (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.fast, ease: EASE.decelerate }}
    >
      {body}
    </motion.div>
  );

  if (!onEdit) return bubble;

  return (
    <div className={cn("flex flex-col gap-1")}>
      {bubble}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onEdit}
          disabled={editDisabled}
          aria-label="Edit this message and regenerate the answer"
          className="text-muted-foreground hover:text-foreground gap-1 px-1.5 font-normal"
        >
          <Pencil className="size-3" aria-hidden="true" />
          Edit
        </Button>
      </div>
    </div>
  );
}
