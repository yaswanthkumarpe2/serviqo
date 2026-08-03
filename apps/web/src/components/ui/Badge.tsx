import type { ReactNode } from "react";

import { cn } from "@/utils/cn";

export type BadgeVariant = "danger" | "warn" | "neutral" | "em" | "success";

interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
  className?: string;
}

/** Priority / status pill. Colour always pairs with a text label — never colour alone. */
export function Badge({ variant, children, className }: BadgeProps) {
  return <span className={cn("badge", `badge--${variant}`, className)}>{children}</span>;
}
