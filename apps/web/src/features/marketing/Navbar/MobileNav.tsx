import { Link } from "react-router-dom";

import { ButtonLink } from "@/components/ui/Button";
import { cn } from "@/utils/cn";

import { mobileNavGroups } from "./navData";

interface MobileNavProps {
  isOpen: boolean;
  onLinkClick: () => void;
}

export function MobileNav({ isOpen, onLinkClick }: MobileNavProps) {
  return (
    <div id="mobileNav" className={cn("mobileNav", isOpen && "is-open")}>
      <div className="mobileNav__in">
        {mobileNavGroups.map((group) => (
          <div key={group.heading}>
            <h6>{group.heading}</h6>
            {group.links.map((link) =>
              // In-page anchors stay plain <a>; a real route needs the
              // router, or it would trigger a full page load.
              link.href.startsWith("/") ? (
                <Link key={link.label} to={link.href} onClick={onLinkClick}>
                  {link.label}
                </Link>
              ) : (
                <a key={link.label} href={link.href} onClick={onLinkClick}>
                  {link.label}
                </a>
              ),
            )}
          </div>
        ))}
        <div className="mobileNav__cta">
          <ButtonLink variant="primary" href="#pricing" onClick={onLinkClick}>
            Get started free
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
