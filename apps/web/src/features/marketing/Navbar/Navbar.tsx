import { useEffect, useState } from "react";

import { ButtonLink } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { BrandMark, CloseIcon, MenuIcon, MoonIcon, SunIcon } from "@/components/ui/icons";
import { useStickyNav } from "@/hooks/useStickyNav";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/utils/cn";

import { MegaMenu } from "./MegaMenu";
import { MobileNav } from "./MobileNav";
import { productLinks, resourceLinks, solutionLinks } from "./navData";

import "./Navbar.css";

type MenuId = "product" | "solutions" | "resources";

export function Navbar() {
  const isStuck = useStickyNav();
  const { theme, toggleTheme } = useTheme();
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!openMenu) return;
    function closeOnOutsideClick() {
      setOpenMenu(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("click", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!mobileOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }
    function closeOnWideResize() {
      if (window.innerWidth > 940) setMobileOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnWideResize);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnWideResize);
    };
  }, [mobileOpen]);

  function toggleMenu(id: MenuId) {
    setOpenMenu((current) => (current === id ? null : id));
  }

  return (
    <header className={cn("nav", isStuck && "is-stuck")} id="nav">
      <div className="wrap nav__in">
        <a className="brand" href="#top">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark />
          </span>
          Serviqo
        </a>

        <nav className="nav__links" aria-label="Primary">
          <MegaMenu
            id="product"
            label="Product"
            links={productLinks}
            isOpen={openMenu === "product"}
            onToggle={() => toggleMenu("product")}
          />
          <MegaMenu
            id="solutions"
            label="Solutions"
            links={solutionLinks}
            narrow
            isOpen={openMenu === "solutions"}
            onToggle={() => toggleMenu("solutions")}
          />
          <div className="nav__item">
            <a href="#ai">AI Agent</a>
          </div>
          <div className="nav__item">
            <a href="#integrations">Integrations</a>
          </div>
          <div className="nav__item">
            <a href="#pricing">Pricing</a>
          </div>
          <MegaMenu
            id="resources"
            label="Resources"
            links={resourceLinks}
            narrow
            isOpen={openMenu === "resources"}
            onToggle={() => toggleMenu("resources")}
          />
        </nav>

        <div className="nav__right">
          <IconButton
            id="themeBtn"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title="Switch theme"
          >
            {theme === "dark" ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
          </IconButton>
          <ButtonLink variant="secondary" size="sm" className="signInBtn" href="#">
            Sign in
          </ButtonLink>
          <ButtonLink variant="primary" size="sm" href="#pricing">
            Get started free
          </ButtonLink>
          <IconButton
            className="mobileBtn"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobileNav"
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <CloseIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
          </IconButton>
        </div>
      </div>

      <MobileNav isOpen={mobileOpen} onLinkClick={() => setMobileOpen(false)} />
    </header>
  );
}
