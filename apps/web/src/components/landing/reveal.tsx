"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { revealState, useReveal } from "./use-reveal";

/**
 * Wraps a block in the shared one-shot entrance.
 *
 * Always a `div`: the wrapper only ever carries motion, so giving callers a
 * polymorphic tag would buy nothing and cost a ref type that no longer matches
 * the element. Anything that needs a landmark puts this inside the landmark.
 *
 * `delayMs` is the stagger. Groups are capped at ~6 members by their callers so
 * the last sibling never arrives noticeably after the first.
 *
 * `min-w-0` is load-bearing. A grid or flex item defaults to `min-width: auto`,
 * so it refuses to shrink below its content's intrinsic width — one
 * `white-space: nowrap` code block inside a wrapper is enough to widen its
 * whole column past a 390px viewport and give the document a horizontal
 * scrollbar. On a plain block in normal flow the declaration does nothing, so
 * it is safe to apply to every reveal rather than hunting for the ones that
 * happen to be laid out by a parent today.
 */
export function Reveal({
  children,
  className,
  delayMs = 0,
  threshold,
}: {
  children: ReactNode;
  className?: string;
  delayMs?: number;
  threshold?: number;
}) {
  const { ref, revealed } = useReveal<HTMLDivElement>(threshold);

  return (
    <div
      ref={ref}
      data-reveal={revealState(revealed)}
      style={delayMs ? { animationDelay: `${delayMs}ms` } : undefined}
      className={cn("min-w-0", className)}
    >
      {children}
    </div>
  );
}
