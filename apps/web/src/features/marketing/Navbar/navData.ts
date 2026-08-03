export interface NavLinkItem {
  title: string;
  description: string;
  href: string;
}

export interface MobileNavGroup {
  heading: string;
  links: { label: string; href: string }[];
}

export const productLinks: NavLinkItem[] = [
  { title: "Live chat", description: "Talk in real time", href: "#demo" },
  { title: "Team inbox", description: "One queue, every channel", href: "#inbox" },
  { title: "Ticketing", description: "Follow through with SLAs", href: "#tickets" },
  { title: "AI support agent", description: "Answers the routine ones", href: "#ai" },
  { title: "Automation", description: "Deterministic routing and rules", href: "#automation" },
  { title: "Knowledge base", description: "Answers people can find", href: "#kb" },
];

export const solutionLinks: NavLinkItem[] = [
  { title: "Customer support", description: "General help desk teams", href: "#pricing" },
  { title: "Technical support", description: "Product and engineering queries", href: "#pricing" },
  { title: "E-commerce", description: "Orders, shipping, returns", href: "#pricing" },
  { title: "SaaS", description: "Onboarding and account issues", href: "#pricing" },
  { title: "Financial services", description: "Regulated, security-first support", href: "#pricing" },
];

export const resourceLinks: NavLinkItem[] = [
  { title: "Documentation", description: "Guides and API reference", href: "#" },
  { title: "Knowledge base", description: "Answers people can find", href: "#kb" },
  { title: "Changelog", description: "What shipped recently", href: "#" },
];

export const mobileNavGroups: MobileNavGroup[] = [
  {
    heading: "Product",
    links: [
      { label: "Live chat", href: "#demo" },
      { label: "Team inbox", href: "#inbox" },
      { label: "Ticketing", href: "#tickets" },
      { label: "AI support agent", href: "#ai" },
      { label: "Automation", href: "#automation" },
      { label: "Knowledge base", href: "#kb" },
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
    heading: "Company",
    links: [
      { label: "Integrations", href: "#integrations" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Documentation", href: "#" },
      { label: "Knowledge base", href: "#kb" },
      { label: "Changelog", href: "#" },
      { label: "Sign in", href: "#" },
    ],
  },
];
