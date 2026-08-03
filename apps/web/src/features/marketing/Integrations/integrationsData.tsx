import type { ReactNode } from "react";

import type { BadgeVariant } from "@/components/ui/Badge";

export interface IntegrationChannel {
  title: string;
  description: string;
  badge: { variant: BadgeVariant; label: string };
  icon: ReactNode;
}

const iconProps = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 };

export const integrationChannels: IntegrationChannel[] = [
  {
    title: "Web chat",
    description: "Embeddable site widget — in active development",
    badge: { variant: "warn", label: "IN DEVELOPMENT" },
    icon: (
      <svg {...iconProps}>
        <path d="M4 4h16v12H8l-4 4V4Z" />
      </svg>
    ),
  },
  {
    title: "Email to ticket",
    description: "Inbound email becomes a tracked conversation",
    badge: { variant: "neutral", label: "PLANNED" },
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3.5 7 8.5 6 8.5-6" />
      </svg>
    ),
  },
  {
    title: "REST API and webhooks",
    description: "Build your own channel or automation on top",
    badge: { variant: "warn", label: "IN DEVELOPMENT" },
    icon: (
      <svg {...iconProps}>
        <path d="M8 6 3 12l5 6M16 6l5 6-5 6" />
      </svg>
    ),
  },
  {
    title: "WhatsApp Business",
    description: "Planned — not yet started",
    badge: { variant: "neutral", label: "PLANNED" },
    icon: (
      <svg {...iconProps}>
        <path d="M4 12a8 8 0 1 1 3.4 6.5L4 20l1.6-3.4A7.9 7.9 0 0 1 4 12Z" />
      </svg>
    ),
  },
  {
    title: "Slack and Microsoft Teams",
    description: "Planned — not yet started",
    badge: { variant: "neutral", label: "PLANNED" },
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <rect x="13" y="13" width="8" height="8" rx="2" />
      </svg>
    ),
  },
];
