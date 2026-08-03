import { Reveal } from "@/components/ui/Reveal";

import { featureOverviewItems } from "./featureOverviewData";

import "./FeatureOverview.css";

export function FeatureOverview() {
  return (
    <section className="section section--tight section--sunk">
      <div className="wrap">
        <Reveal className="head head--center">
          <h2 className="h2">Everything you need for exceptional support.</h2>
        </Reveal>
        <Reveal className="featGrid">
          {featureOverviewItems.map((item) => (
            <a key={item.title} href={item.href} className="featGrid__item">
              <span className="featGrid__i">{item.icon}</span>
              <b>{item.title}</b>
              <p>{item.description}</p>
            </a>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
