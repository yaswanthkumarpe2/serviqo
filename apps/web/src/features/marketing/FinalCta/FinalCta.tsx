import { ButtonLink } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";

import "./FinalCta.css";

export function FinalCta() {
  return (
    <section className="section section--tight" id="pricing">
      <div className="wrap">
        <Reveal className="cta">
          <Eyebrow className="cta__eyebrow">Get started</Eyebrow>
          <h2 className="h2" style={{ margin: "12px 0 0" }}>
            Your queue is waiting.
          </h2>
          <p className="lede">
            Set up Serviqo with your own team, or look around a workspace already full of conversations.
          </p>
          <div className="cta__row">
            <ButtonLink variant="primary" href="#">
              Start free trial
            </ButtonLink>
          </div>
          <div style={{ marginTop: 28, paddingTop: 24, borderTop: "1px solid var(--dark-border)" }}>
            <Eyebrow className="cta__eyebrow" style={{ marginBottom: 12 }}>
              Or explore a live demo workspace
            </Eyebrow>
            <div className="cta__row" style={{ marginTop: 0 }}>
              <ButtonLink variant="onDark" size="sm" href="#">
                View as customer
              </ButtonLink>
              <ButtonLink variant="onDark" size="sm" href="#">
                View as agent
              </ButtonLink>
              <ButtonLink variant="onDark" size="sm" href="#">
                View as admin
              </ButtonLink>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
