import type { Transition, Variants } from "motion/react";

/**
 * Motion vocabulary.
 *
 * One place for durations, easings, and shared variants so every surface moves
 * with the same rhythm. Components should import from here rather than
 * hard-coding numbers.
 *
 * Principles:
 * - Interaction-driven: motion answers a user action or a state change.
 * - Fast stays out of the way; slower tiers are reserved for layout/page scale.
 * - Transforms + opacity only (compositor-friendly, no layout thrash).
 * - `prefers-reduced-motion` is honoured globally via MotionConfig at the app
 *   root, so primitives never need to branch on it themselves.
 */

/** Duration tiers, in seconds (Motion's unit). Mirrors the CSS `--duration-*` tokens. */
export const DURATION = {
  /** Microinteraction feedback: hover, press, toggle. */
  fast: 0.13,
  /** Component and state transitions: cards, popovers, list items. */
  normal: 0.22,
  /** Larger surfaces: panels, drawers, multi-element choreography. */
  slow: 0.38,
  /** Rare, deliberate moments: first-run, route-level reveals. */
  deliberate: 0.56,
} as const;

/** Cubic-bezier easings. Mirrors the CSS `--ease-*` tokens. */
export const EASE = {
  /** Confident, minimal overshoot for most transitions. */
  standard: [0.2, 0, 0, 1] as [number, number, number, number],
  /** Entrances: arrives quickly, settles gently. */
  decelerate: [0.05, 0.7, 0.1, 1] as [number, number, number, number],
  /** Exits: leaves promptly without lingering. */
  accelerate: [0.3, 0, 0.8, 0.15] as [number, number, number, number],
  /** Emphasis: a touch of life for an element the eye should follow. */
  emphasized: [0.34, 1.28, 0.64, 1] as [number, number, number, number],
} as const;

/** Spring presets for gesture-driven and layout motion. */
export const SPRING = {
  soft: { type: "spring", stiffness: 260, damping: 30, mass: 0.9 },
  snappy: { type: "spring", stiffness: 420, damping: 32, mass: 0.7 },
} satisfies Record<string, Transition>;

/** Shared transition: pass a tier, optionally override. */
export function transition(
  tier: keyof typeof DURATION = "normal",
  ease: keyof typeof EASE = "standard",
  overrides: Transition = {},
): Transition {
  return { duration: DURATION[tier], ease: EASE[ease], ...overrides };
}

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  visible: { opacity: 1, scale: 1 },
};

/** Parent that sequences its children. Pair with `staggerItem`. */
export const staggerContainer = (stagger = 0.045, delayChildren = 0): Variants => ({
  hidden: {},
  visible: { transition: { staggerChildren: stagger, delayChildren } },
});

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
};

/** Directional offsets for slide entrances, in pixels. */
export const SLIDE_OFFSET = 12;

export type SlideDirection = "up" | "down" | "left" | "right";

export function slideOffset(direction: SlideDirection) {
  switch (direction) {
    case "up":
      return { y: SLIDE_OFFSET };
    case "down":
      return { y: -SLIDE_OFFSET };
    case "left":
      return { x: SLIDE_OFFSET };
    case "right":
      return { x: -SLIDE_OFFSET };
  }
}
