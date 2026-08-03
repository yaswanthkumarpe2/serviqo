import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/utils/cn";
import { useReveal } from "@/hooks/useReveal";

interface RevealProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Fades/slides content in the first time it scrolls into view. */
export function Reveal({ children, className, ...rest }: RevealProps) {
  const { ref, isIn } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={cn("reveal", isIn && "is-in", className)} {...rest}>
      {children}
    </div>
  );
}
