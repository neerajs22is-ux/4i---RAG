"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";

/**
 * Truthful request status.
 *
 * `/ask` is a single non-streaming request, so the client genuinely cannot know
 * whether retrieval, generation or verification is happening. This component
 * therefore reports only what the *client* observes — that a request is in
 * flight and how long it has been — and never invents backend stages.
 *
 * The wording escalates with elapsed time on a fixed, explainable schedule:
 *  < 2.5 s  "Answering…"
 *  < 15 s   "Still answering…"
 *  ≥ 15 s   "Taking longer than usual…"
 */
export function RequestStatus({ startedAt }: { startedAt: number }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const tick = () => setElapsedMs(Date.now() - startedAt);
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const seconds = Math.floor(elapsedMs / 1000);
  const label =
    elapsedMs < 2500
      ? "Answering"
      : elapsedMs < 15000
        ? "Still answering"
        : "Taking longer than usual";

  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2.5">
      <span className="relative flex size-2 shrink-0" aria-hidden="true">
        <motion.span
          className="bg-primary absolute inline-flex size-2 rounded-full"
          animate={{ opacity: [0.35, 1, 0.35], scale: [1, 1.25, 1] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      </span>
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-muted-foreground/70 font-mono text-2xs">
        {seconds}s
      </span>
    </div>
  );
}
