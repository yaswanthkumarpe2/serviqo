import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/utils/cn";

export type ButtonVariant = "primary" | "secondary" | "onDark";
export type ButtonSize = "default" | "sm";

interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

function buttonClassName({ variant = "primary", size = "default", className }: ButtonStyleProps) {
  return cn("btn", `btn--${variant}`, size === "sm" && "btn--sm", className);
}

interface ButtonProps extends ButtonStyleProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  children: ReactNode;
}

/** Renders `.btn` as a real `<button>` — for in-page actions with no navigation. */
export function Button({ variant, size, className, children, ...rest }: ButtonProps) {
  return (
    <button className={buttonClassName({ variant, size, className })} {...rest}>
      {children}
    </button>
  );
}

interface ButtonLinkProps extends ButtonStyleProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> {
  children: ReactNode;
}

/** Renders `.btn` as an `<a>` — every marketing CTA is a link, never a form submit. */
export function ButtonLink({ variant, size, className, children, ...rest }: ButtonLinkProps) {
  return (
    <a className={buttonClassName({ variant, size, className })} {...rest}>
      {children}
    </a>
  );
}
