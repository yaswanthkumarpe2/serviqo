import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";

import { securityItems } from "./securityData";

import "./Security.css";

export function Security() {
  return (
    <section className="section section--dark">
      <div className="wrap">
        <Reveal className="head">
          <Eyebrow>Security and reliability</Eyebrow>
          <h2 className="h2" style={{ color: "var(--text-inverse)", margin: "12px 0 14px" }}>
            Built for more than one company.
          </h2>
          <p className="lede">
            Every business record carries an organization ID, and isolation is enforced in the data layer.
            These are the principles the platform is being built to — not an independent audit or
            certification claim.
          </p>
        </Reveal>

        <Reveal className="grid3">
          {securityItems.map((item) => (
            <div key={item.title} className="scard">
              <span className="scard__i">{item.icon}</span>
              <h4>{item.title}</h4>
              <p>{item.description}</p>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
