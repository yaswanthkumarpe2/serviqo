import { useEffect, useRef, useState } from "react";

import { CheckIcon, CopyIcon, ExternalLinkIcon, LinkIcon } from "./workspaceIcons";

import "./WidgetLinkCard.css";

/**
 * The organisation's customer chat link, for staff to hand out (ADR-038 §4).
 *
 * Shown to every member, agents included. The link is not a secret and grants
 * nothing — it opens an anonymous chat with this organisation, which is what
 * the organisation wants any customer to be able to do — so there is no reason
 * to hide it from the people most likely to paste it into an email.
 *
 * The URL comes from the server, built from the organisation's immutable slug.
 * The client never assembles one, so a link copied here is exactly the link
 * the server will resolve.
 */
export function WidgetLinkCard({ widgetUrl }: { widgetUrl: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(widgetUrl);
      setCopied(true);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied. The link stays visible and selectable,
      // so this is a missed convenience rather than a failure to report.
    }
  }

  return (
    <section className="linkCard card" aria-labelledby="widget-link-heading">
      <div className="linkCard__head">
        <span className="linkCard__icon" aria-hidden="true">
          <LinkIcon />
        </span>
        <div>
          <h2 className="linkCard__title" id="widget-link-heading">
            Customer chat link
          </h2>
          <p className="linkCard__lede">
            Share this with customers. They can chat with your team straight away — no account needed.
          </p>
        </div>
      </div>

      <div className="linkCard__row">
        {/* Not "Customer chat link": that is the section's name, and two
            controls sharing one accessible name cannot be told apart. */}
        <label className="linkCard__srOnly" htmlFor="widget-link-url">
          Link to share
        </label>
        <input
          id="widget-link-url"
          className="linkCard__url"
          type="text"
          value={widgetUrl}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="linkCard__action linkCard__action--primary" onClick={() => void copy()}>
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? "Copied" : "Copy link"}
        </button>
        <a className="linkCard__action" href={widgetUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon aria-hidden="true" />
          Open
        </a>
      </div>

      {/* Announced without moving focus away from the button just pressed. */}
      <p className="linkCard__srOnly" role="status" aria-live="polite">
        {copied ? "Link copied to clipboard" : ""}
      </p>
    </section>
  );
}
