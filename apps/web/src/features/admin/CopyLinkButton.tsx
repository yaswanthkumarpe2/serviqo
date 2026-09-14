import { useEffect, useRef, useState } from "react";

import { CheckIcon, CopyIcon, ExternalLinkIcon } from "@/features/workspace/workspaceIcons";

/**
 * Copy and open buttons for an organisation's chat link, sized for a table
 * row in the dark console (ADR-039 §2).
 */
export function ChatLinkActions({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Denied clipboard: the link is still shown and selectable.
    }
  }

  return (
    <span className="console__linkActions">
      <button
        type="button"
        className="console__iconButton"
        onClick={() => void copy()}
        aria-label={copied ? `Copied ${label} chat link` : `Copy ${label} chat link`}
        title={copied ? "Copied" : "Copy link"}
      >
        {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      </button>
      <a
        className="console__iconButton"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} chat link`}
        title="Open"
      >
        <ExternalLinkIcon aria-hidden="true" />
      </a>
    </span>
  );
}
