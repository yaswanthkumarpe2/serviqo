import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/utils/cn";

interface MiniButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  filled?: boolean;
}

/** Compact 27px action used inside the automation rule card and the AI brief panel. */
export function MiniButton({ filled, className, ...rest }: MiniButtonProps) {
  return <button className={cn("mini", filled && "mini--fill", className)} {...rest} />;
}
