import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/utils/cn";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** 34px square icon-only button — theme toggle, mobile menu trigger. */
export function IconButton({ className, ...rest }: IconButtonProps) {
  return <button className={cn("iconbtn", className)} {...rest} />;
}
