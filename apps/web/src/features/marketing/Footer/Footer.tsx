import { BrandMark } from "@/components/ui/icons";

import { footerGroups } from "./footerData";

import "./Footer.css";

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot__grid">
          <div>
            <a className="brand" href="#top">
              <span className="brand__mark" aria-hidden="true">
                <BrandMark width={22} height={22} />
              </span>
              Serviqo
            </a>
            <p style={{ fontSize: 13, color: "var(--text-3)", marginTop: 12, maxWidth: "30ch" }}>
              Chat, AI, tickets and your team in one support workspace.
            </p>
          </div>
          {footerGroups.map((group) => (
            <div key={group.heading}>
              <h5>{group.heading}</h5>
              <ul>
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="foot__bottom">
          <span>© {year} Serviqo</span>
        </div>
      </div>
    </footer>
  );
}
