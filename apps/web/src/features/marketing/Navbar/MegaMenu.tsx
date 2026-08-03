import { ChevronDownIcon } from "@/components/ui/icons";
import { cn } from "@/utils/cn";

import type { NavLinkItem } from "./navData";

interface MegaMenuProps {
  id: string;
  label: string;
  links: NavLinkItem[];
  narrow?: boolean;
  isOpen: boolean;
  onToggle: () => void;
}

export function MegaMenu({ id, label, links, narrow, isOpen, onToggle }: MegaMenuProps) {
  const panelId = `mega-${id}`;

  return (
    <div className={cn("nav__item", isOpen && "is-open")}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {label}
        <ChevronDownIcon aria-hidden="true" />
      </button>
      <div id={panelId} className={cn("mega", narrow && "mega--narrow")}>
        {links.map((link) => (
          <a key={link.title} href={link.href}>
            <b>{link.title}</b>
            <span>{link.description}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
