export interface FooterGroup {
  heading: string;
  links: { label: string; href: string }[];
}

export const footerGroups: FooterGroup[] = [
  {
    heading: "Product",
    links: [
      { label: "Live chat", href: "#demo" },
      { label: "Ticketing", href: "#tickets" },
      { label: "AI support agent", href: "#ai" },
      { label: "Automation", href: "#automation" },
    ],
  },
  {
    heading: "Solutions",
    links: [
      { label: "Customer support", href: "#pricing" },
      { label: "E-commerce", href: "#pricing" },
      { label: "SaaS", href: "#pricing" },
      { label: "Financial services", href: "#pricing" },
    ],
  },
  {
    heading: "Platform",
    links: [
      { label: "Security", href: "#" },
      { label: "Multi-org", href: "#" },
      { label: "API and webhooks", href: "#" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Documentation", href: "#" },
      { label: "Knowledge base", href: "#kb" },
      { label: "Changelog", href: "#" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
    ],
  },
];
