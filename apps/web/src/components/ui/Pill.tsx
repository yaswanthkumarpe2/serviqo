import type { ReactNode } from "react";

import { cn } from "@/utils/cn";

/** Hero eyebrow pill with a leading presence dot. */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("pill", className)}>
      <i className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}
