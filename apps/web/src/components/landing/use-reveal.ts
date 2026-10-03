"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One-shot scroll entrance.
 *
 * Every entrance on the landing page fires exactly once and then unobserves:
 * a section that re-animates each time the visitor scrolls back up reads as a
 * bug, and keeping observers alive for the life of the page costs main-thread
 * work on every scroll for no benefit.
 *
 * `revealed` starts false, which is also what the server renders. The hidden
 * *visual* state is applied by CSS gated on `html.js`, so a visitor without
 * scripting — for whom this effect never runs — sees fully opaque content
 * rather than an empty page.
 */
export function useReveal<T extends Element = HTMLDivElement>(threshold = 0.15) {
  const ref = useRef<T | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Older browsers and jsdom have no observer; showing the content beats
    // hiding it forever.
    if (typeof IntersectionObserver === "undefined") {
      setRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRevealed(true);
        observer.disconnect();
      },
      { threshold },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, revealed };
}

/** The attribute value every `[data-reveal]` CSS rule keys on. */
export function revealState(revealed: boolean): "pending" | "shown" {
  return revealed ? "shown" : "pending";
}
