"use client";

import { motion } from "motion/react";

import { DURATION, EASE } from "@/lib/motion";

/**
 * User message.
 *
 * Deliberately compact and visually secondary to the answer: a tinted surface,
 * no card chrome, no actions beyond what the transcript needs. The question is
 * preserved verbatim (whitespace included) so it reads as the user wrote it.
 */
export function UserMessage({
  content,
  entrance = false,
}: {
  content: string;
  entrance?: boolean;
}) {
  const body = (
      <p className="text-base leading-relaxed break-words whitespace-pre-wrap">
      {content}
    </p>
  );

  const className =
    "bg-secondary/70 hairline rounded-xl border px-3.5 py-2.5";

  if (!entrance) return <div className={className}>{body}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.fast, ease: EASE.decelerate }}
    >
      {body}
    </motion.div>
  );
}
