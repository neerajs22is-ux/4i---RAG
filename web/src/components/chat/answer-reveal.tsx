"use client";

import { useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";

/**
 * Progressive reveal for a newly generated answer.
 *
 * The backend returns one completed response (no streaming), so this animates
 * the *presentation* of already-rendered Markdown: each top-level block
 * cascades in via the `.answer-reveal` CSS animation (see `globals.css`),
 * with its delay carried on a `--reveal-i` custom property. Capped so even
 * very long answers finish in ~1.5 s.
 *
 * Deliberately DOM-light: one layout effect assigns per-block delays, no
 * React state updates per block, no re-parsing, no remounts — citation
 * buttons stay the exact same interactive elements throughout, and the final
 * DOM is identical to the non-animated render (class and properties are
 * removed on completion). Full text is in the DOM from mount, so screen
 * readers and text selection work immediately.
 *
 * Runs only when `run` is true (fresh answers). Stored transcripts,
 * reloads and remounts render statically. Reduced motion renders statically.
 * Any pointer/keyboard/wheel/touch interaction finishes instantly.
 */
const STEP_MS = 40;
const INDEX_CAP = 30;
const SETTLE_MS = 400;

export function AnswerReveal({
  run,
  children,
}: {
  /** True only for a newly generated answer, never for stored transcripts. */
  run: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const active = run && !prefersReducedMotion;

  useLayoutEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const kids = [...root.children] as HTMLElement[];
    kids.forEach((el, index) =>
      el.style.setProperty("--reveal-i", String(Math.min(index, INDEX_CAP))),
    );
    root.classList.add("answer-reveal");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.classList.remove("answer-reveal");
      kids.forEach((el) => el.style.removeProperty("--reveal-i"));
    };
    const timer = window.setTimeout(finish, INDEX_CAP * STEP_MS + SETTLE_MS);
    // Skip on genuine user gestures only. A `scroll` listener would also fire
    // for the chat's own intentional bottom-pinning and kill every reveal, so
    // wheel/touch input is used instead: programmatic scrolls never trigger it.
    const scroller = root.closest("[data-chat-scroll]");
    const scrollTarget = scroller ?? root;
    root.addEventListener("pointerdown", finish);
    root.addEventListener("keydown", finish);
    scrollTarget.addEventListener("wheel", finish, { passive: true });
    scrollTarget.addEventListener("touchmove", finish, { passive: true });
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener("pointerdown", finish);
      root.removeEventListener("keydown", finish);
      scrollTarget.removeEventListener("wheel", finish);
      scrollTarget.removeEventListener("touchmove", finish);
      finish();
    };
  }, [active]);

  return <div ref={ref}>{children}</div>;
}
