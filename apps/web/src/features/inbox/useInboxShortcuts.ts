import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts for the inbox (ADR-042 §5).
 *
 * Single keys, the way mail clients do it, and only while focus is NOT in a
 * text field — typing "j" into a reply must type a "j". Modifier combinations
 * are left alone so the browser's and the operating system's keep working.
 */

export const INBOX_SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "j / k", action: "Next / previous conversation" },
  { keys: "/", action: "Search conversations" },
  { keys: "r", action: "Reply" },
  { keys: "n", action: "Write an internal note" },
  { keys: "?", action: "Show or hide these shortcuts" },
  { keys: "Esc", action: "Leave a text field, close this list" },
];

export interface ShortcutHandlers {
  next: () => void;
  previous: () => void;
  search: () => void;
  reply: () => void;
  note: () => void;
  toggleHelp: () => void;
  closeHelp: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

export function useInboxShortcuts(handlers: ShortcutHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        latest.current.closeHelp();
        return;
      }
      if (isTypingTarget(event.target)) return;

      const actions: Record<string, () => void> = {
        j: latest.current.next,
        k: latest.current.previous,
        "/": latest.current.search,
        r: latest.current.reply,
        n: latest.current.note,
        "?": latest.current.toggleHelp,
      };
      const action = actions[event.key];
      if (action === undefined) return;
      event.preventDefault();
      action();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
