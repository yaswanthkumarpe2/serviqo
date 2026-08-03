import type { HTMLAttributes } from "react";

import { cn } from "@/utils/cn";

type EyebrowProps = HTMLAttributes<HTMLSpanElement>;

/** Mono uppercase section label, used above nearly every `.h2` on the page. */
export function Eyebrow({ className, ...rest }: EyebrowProps) {
  return <span className={cn("eyebrow", className)} {...rest} />;
}
