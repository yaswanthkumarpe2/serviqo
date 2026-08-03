import { useEffect, useState } from "react";

/** True once the page has scrolled past `threshold` — draws the nav's bottom hairline. */
export function useStickyNav(threshold = 8): boolean {
  const [isStuck, setIsStuck] = useState(false);

  useEffect(() => {
    function handleScroll() {
      setIsStuck(window.scrollY > threshold);
    }
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [threshold]);

  return isStuck;
}
