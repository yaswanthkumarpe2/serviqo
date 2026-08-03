import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";

import { integrationChannels } from "./integrationsData";

import "./Integrations.css";

export function Integrations() {
  return (
    <section className="section section--tight" id="integrations">
      <div className="wrap">
        <Reveal className="head head--center">
          <Eyebrow>Integrations</Eyebrow>
          <h2 className="h2">One inbox for every channel.</h2>
          <p className="lede" style={{ margin: "0 auto" }}>
            Serviqo is in active development. Nothing below is labeled available until it has shipped and been
            tested end to end.
          </p>
        </Reveal>

        <Reveal className="chanList" style={{ maxWidth: 640, margin: "0 auto" }}>
          {integrationChannels.map((channel) => (
            <div key={channel.title} className="chanRow2">
              <span className="chan__i">{channel.icon}</span>
              <div>
                <b>{channel.title}</b>
                <span className="desc">{channel.description}</span>
              </div>
              <Badge variant={channel.badge.variant}>{channel.badge.label}</Badge>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
