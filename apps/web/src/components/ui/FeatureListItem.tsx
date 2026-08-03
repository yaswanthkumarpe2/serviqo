import type { ReactNode } from "react";

/** A checked feature line inside `.featlist` — AI split, ticketing, and knowledge base sections. */
export function FeatureListItem({ children }: { children: ReactNode }) {
  return (
    <li>
      <span className="tick" aria-hidden="true">
        ✓
      </span>
      <span>{children}</span>
    </li>
  );
}
