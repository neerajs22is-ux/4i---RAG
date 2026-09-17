"use client";

import { motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

import {
  DURATION,
  fadeIn,
  scaleIn,
  slideOffset,
  staggerContainer,
  staggerItem,
  transition,
  type SlideDirection,
} from "@/lib/motion";

/**
 * Foundation motion primitives.
 *
 * Deliberately a small set — five exports — so application surfaces compose the
 * same handful of behaviours instead of inventing bespoke animations.
 *
 * All primitives:
 * - animate transform + opacity only;
 * - default to `whileInView` with a one-shot reveal and a sensible viewport
 *   margin, so scroll entrances never re-trigger distractingly;
 * - inherit `prefers-reduced-motion` from the app-level MotionConfig.
 *
 * Client-only: Motion reads the DOM, so these are marked "use client".
 */

type BaseProps = Omit<HTMLMotionProps<"div">, "variants" | "initial" | "animate"> & {
  children?: ReactNode;
  /** Seconds to wait before this element animates in. */
  delay?: number;
  /** Use a slower tier for large surfaces. */
  tier?: keyof typeof DURATION;
  /** Animate immediately on mount instead of waiting for viewport entry. */
  onMount?: boolean;
};

function viewportProps(onMount?: boolean) {
  return onMount
    ? {}
    : { whileInView: "visible" as const, viewport: { once: true, margin: "-10% 0px -10% 0px" } };
}

/** Fade + rise. The default entrance for most content. */
export function FadeIn({
  children,
  delay = 0,
  tier = "normal",
  onMount = false,
  ...props
}: BaseProps) {
  return (
    <motion.div
      initial="hidden"
      animate={onMount ? "visible" : undefined}
      {...viewportProps(onMount)}
      variants={fadeIn}
      transition={transition(tier, "decelerate", { delay })}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Directional entrance. Use when an element's origin matters spatially. */
export function SlideIn({
  children,
  delay = 0,
  tier = "normal",
  direction = "up",
  onMount = false,
  ...props
}: BaseProps & { direction?: SlideDirection }) {
  return (
    <motion.div
      initial="hidden"
      animate={onMount ? "visible" : undefined}
      {...viewportProps(onMount)}
      variants={{
        hidden: { opacity: 0, ...slideOffset(direction) },
        visible: { opacity: 1, x: 0, y: 0 },
      }}
      transition={transition(tier, "decelerate", { delay })}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Subtle scale entrance. Reserve for elements that gain focus or presence. */
export function ScaleIn({
  children,
  delay = 0,
  tier = "normal",
  onMount = false,
  ...props
}: BaseProps) {
  return (
    <motion.div
      initial="hidden"
      animate={onMount ? "visible" : undefined}
      {...viewportProps(onMount)}
      variants={scaleIn}
      transition={transition(tier, "emphasized", { delay })}
      {...props}
    >
      {children}
    </motion.div>
  );
}

const MotionConfigTransition = transition("normal", "standard");

/** Parent that sequences direct `StaggerItem` children. */
export function Stagger({
  children,
  stagger = 0.045,
  delayChildren = 0,
  onMount = true,
  ...props
}: BaseProps & { stagger?: number; delayChildren?: number }) {
  return (
    <motion.div
      initial="hidden"
      animate={onMount ? "visible" : undefined}
      {...viewportProps(onMount)}
      variants={staggerContainer(stagger, delayChildren)}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** A single sequenced child of `Stagger`. */
export function StaggerItem({ children, ...props }: BaseProps) {
  return (
    <motion.div variants={staggerItem} transition={MotionConfigTransition} {...props}>
      {children}
    </motion.div>
  );
}
