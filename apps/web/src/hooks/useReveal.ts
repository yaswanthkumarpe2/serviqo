import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const supportsIntersectionObserver = typeof IntersectionObserver !== "undefined";

/**
 * Scroll-reveal: flips `isIn` true the first time the element crosses into
 * view, then stops observing. Skips straight to visible when the user
 * prefers reduced motion or the browser has no IntersectionObserver —
 * computed directly from render inputs rather than via an effect, so
 * mount never triggers an extra synchronous render.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [observedIn, setObservedIn] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const isIn = reducedMotion || !supportsIntersectionObserver || observedIn;

  useEffect(() => {
    if (reducedMotion || !supportsIntersectionObserver) return;

    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setObservedIn(true);
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -60px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return { ref, isIn };
}
