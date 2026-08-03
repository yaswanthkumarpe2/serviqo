import type { ReactNode } from "react";

export interface FeatureOverviewItem {
  href: string;
  title: string;
  description: string;
  icon: ReactNode;
}

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 };

export const featureOverviewItems: FeatureOverviewItem[] = [
  {
    href: "#inbox",
    title: "Unified inbox",
    description: "All conversations from every channel, in one place.",
    icon: (
      <svg {...iconProps}>
        <path d="M4 4h16v12H8l-4 4V4Z" />
      </svg>
    ),
  },
  {
    href: "#ai",
    title: "AI + human support",
    description: "AI resolves routine issues. Humans handle the rest.",
    icon: (
      <svg {...iconProps}>
        <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9l2-6.5Z" />
      </svg>
    ),
  },
  {
    href: "#tickets",
    title: "Ticket management",
    description: "Auto-create, assign and track tickets with SLAs.",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M3 10h18" />
      </svg>
    ),
  },
  {
    href: "#automation",
    title: "Automation",
    description: "Deterministic greetings, routing and updates.",
    icon: (
      <svg {...iconProps}>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <circle cx="9" cy="10" r="1" />
        <circle cx="15" cy="10" r="1" />
        <path d="M9 15h6" />
      </svg>
    ),
  },
  {
    href: "#kb",
    title: "Knowledge base",
    description: "Centralized articles for agents and AI to answer faster.",
    icon: (
      <svg {...iconProps}>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v18H6.5A2.5 2.5 0 0 1 4 18.5v-13Z" />
        <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v18h5.5a2.5 2.5 0 0 0 2.5-2.5v-13Z" />
      </svg>
    ),
  },
  {
    href: "#analytics",
    title: "Analytics",
    description: "Track performance, CSAT and resolution metrics.",
    icon: (
      <svg {...iconProps}>
        <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
      </svg>
    ),
  },
];
