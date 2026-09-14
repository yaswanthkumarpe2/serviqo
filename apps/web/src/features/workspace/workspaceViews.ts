/**
 * The workspace's top-level sections (ADR-033 §2).
 *
 * One module rather than a constant inside the page, because three things
 * need to agree about them: the nav that renders the links, the shell that
 * decides which panel to mount, and the overview's quick-access cards, which
 * navigate by id. A literal repeated across those three is a typo away from a
 * card that goes nowhere.
 *
 * Every entry here is a section that EXISTS and does something. The mockup
 * this shell follows also showed "Notifications", and it is deliberately
 * absent: nothing in Serviqo generates a notification yet, and a nav item
 * that opens an empty page is a promise the product does not keep.
 */
export const WORKSPACE_VIEWS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "chats", label: "My Chats" },
  { id: "contacts", label: "Contacts" },
  { id: "team", label: "Team" },
  { id: "settings", label: "Settings" },
] as const;

export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number]["id"];
