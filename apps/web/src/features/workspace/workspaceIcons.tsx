import type { SVGProps } from "react";

/**
 * The workspace shell's own icons (ADR-033 §5).
 *
 * Kept beside the feature rather than added to `components/ui/icons.tsx`,
 * which holds the marketing site's set. These are 24-grid stroked glyphs on a
 * shared `strokeWidth` so a row of quick-access cards reads as one family;
 * mixing them into a module whose icons were drawn for a landing page is how
 * that consistency gets lost.
 *
 * Every one takes `SVGProps` and sets no colour of its own — `currentColor`
 * means a card decides its icon's colour by deciding its text colour, and the
 * dark theme needs no second definition.
 */

/** Shared by every glyph below, so none can drift in weight or line join. */
const STROKE: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function ChatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

export function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function PeopleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
    </svg>
  );
}

export function InboxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </svg>
  );
}

export function CogIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

/** A chain link: the organisation's customer chat link (ADR-038). */
export function LinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function ExternalLinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
    </svg>
  );
}

export function CodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M16 18l6-6-6-6" />
      <path d="M8 6l-6 6 6 6" />
    </svg>
  );
}
