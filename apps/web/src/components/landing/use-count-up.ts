"use client";

import { useEffect, useRef, useState } from "react";

/** Matches the `cubic-bezier(0.22, 1, 0.36, 1)` feel of the CSS entrances. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Counts from 0 to `target` once, driven by rAF rather than a CSS keyframe
 * because the tween has to land on integers a screen reader could read.
 *
 * Returns `target` immediately when the visitor has asked for reduced motion or
 * when `run` is false-y for the whole lifetime of the component, so the number
 * is never left sitting at zero.
 */
export function useCountUp(target: number, run: boolean, durationMs = 900): number {
  const [value, setValue] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (!run || started.current) return;
    started.current = true;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }

    let frame = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      setValue(Math.round(easeOut(progress) * target));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, target, durationMs]);

  return run ? value : 0;
}
