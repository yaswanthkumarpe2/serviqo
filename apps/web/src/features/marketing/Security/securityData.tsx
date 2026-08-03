import type { ReactNode } from "react";

export interface SecurityItem {
  title: string;
  description: string;
  icon: ReactNode;
}

const iconProps = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 };

export const securityItems: SecurityItem[] = [
  {
    title: "Tenant isolation",
    description: "Queries are scoped to the caller's organization at the repository layer.",
    icon: (
      <svg {...iconProps}>
        <path d="M12 3 4 6.5v5c0 5 3.4 8.6 8 9.5 4.6-.9 8-4.5 8-9.5v-5L12 3Z" />
      </svg>
    ),
  },
  {
    title: "Rotating tokens",
    description: "Short-lived access tokens with revocable refresh tokens. Passwords hashed, never logged.",
    icon: (
      <svg {...iconProps}>
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    ),
  },
  {
    title: "Roles that mean something",
    description: "Checked on every route and every socket event, not just hidden in the UI.",
    icon: (
      <svg {...iconProps}>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      </svg>
    ),
  },
  {
    title: "Audit trail",
    description: "Every assignment, status change and AI-applied suggestion is logged with an actor.",
    icon: (
      <svg {...iconProps}>
        <path d="M4 4h16v16H4z" />
        <path d="M8 9h8M8 13h5" />
      </svg>
    ),
  },
  {
    title: "Uploads under control",
    description: "Type, extension and size validated server-side; files stored under generated names.",
    icon: (
      <svg {...iconProps}>
        <path d="M14 3v5h5" />
        <path d="M14 3H6v18h12V8l-4-5Z" />
      </svg>
    ),
  },
  {
    title: "Your data, your retention",
    description: "Configure retention, export a customer's history, delete it on request.",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
    ),
  },
];
