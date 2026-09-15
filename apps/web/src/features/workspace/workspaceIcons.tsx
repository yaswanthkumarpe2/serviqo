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

/** An organisation: a building (ADR-039). */
export function OrganisationIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M3 21h18" />
      <path d="M5 21V5a2 2 0 012-2h6a2 2 0 012 2v16" />
      <path d="M15 9h2a2 2 0 012 2v10" />
      <path d="M9 7h2M9 11h2M9 15h2" />
    </svg>
  );
}

/** Super admin / platform standing: a shield. */
export function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

/** A support agent: a headset. */
export function HeadsetIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M3 14v-2a9 9 0 0118 0v2" />
      <path d="M21 15a2 2 0 01-2 2h-1v-5h1a2 2 0 012 2z" />
      <path d="M3 15a2 2 0 002 2h1v-5H5a2 2 0 00-2 2z" />
      <path d="M18 17v1a3 3 0 01-3 3h-2" />
    </svg>
  );
}

/** The customer chat widget: a chat window with a message line. */
export function WidgetIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M7 9h10M7 13h6" />
      <path d="M8 18l-2 3" />
    </svg>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ArrowLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

export function PauseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <path d="M10 4H6v16h4zM18 4h-4v16h4z" />
    </svg>
  );
}

export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <path d="M6 4l14 8-14 8z" />
    </svg>
  );
}

export function BellIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" {...STROKE} {...props}>
      <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}

export function BellOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" {...STROKE} {...props}>
      <path d="M13.73 21a2 2 0 01-3.46 0" />
      <path d="M18.63 13A17.9 17.9 0 0118 8" />
      <path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14" />
      <path d="M18 8a6 6 0 00-9.33-5" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

export function VolumeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" {...STROKE} {...props}>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
    </svg>
  );
}

export function TagIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="15" height="15" {...STROKE} {...props}>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
      <path d="M7 7h.01" />
    </svg>
  );
}

export function NoteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" {...STROKE} {...props}>
      <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

export function KeyboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" {...STROKE} {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}

export function PaperclipIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function SmileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" {...STROKE} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01M15 9h.01" />
    </svg>
  );
}

export function VolumeOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" {...STROKE} {...props}>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M23 9l-6 6M17 9l6 6" />
    </svg>
  );
}
