import type { ReactNode } from "react";

import { cn } from "@/utils/cn";
import { SparkIcon } from "@/components/ui/icons";

export type MessageVariant = "in" | "out" | "ai";

interface MessageBubbleProps {
  /** "in" = other party (left, sunk fill) · "out" = this pane's own sender (right, emerald-50)
   *  · "ai" = Serviqo AI (left, outlined — never filled, per the "outlined is machine" rule). */
  variant: MessageVariant;
  /** Sender label shown above the bubble text, e.g. "Serviqo AI" or a human agent's name. */
  tag?: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}

export function MessageBubble({ variant, tag, meta, children, className }: MessageBubbleProps) {
  const isAi = variant === "ai";
  return (
    <div className={cn("msg", `msg--${variant}`, className)}>
      <div className="msg__bubble">
        {tag ? (
          <div className={cn("msg__tag", !isAi && "msg__tag--human")}>
            {isAi && <SparkIcon width={10} height={10} aria-hidden="true" />}
            {tag}
          </div>
        ) : null}
        {children}
      </div>
      {meta ? <div className="msg__meta">{meta}</div> : null}
    </div>
  );
}

export function SystemLine({ children }: { children: ReactNode }) {
  return (
    <div className="msg msg--sys">
      <span className="line" aria-hidden="true" />
      <span>{children}</span>
      <span className="line" aria-hidden="true" />
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="typing" role="status" aria-label="Typing">
      <i />
      <i />
      <i />
    </div>
  );
}
