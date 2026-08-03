import { ButtonLink } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Reveal } from "@/components/ui/Reveal";
import { ArrowRightIcon } from "@/components/ui/icons";
import { useReveal } from "@/hooks/useReveal";
import { cn } from "@/utils/cn";

import { LiveDemo } from "./LiveDemo";

import "./Hero.css";

export function Hero() {
  const { ref: demoTitleRef, isIn: demoTitleIsIn } = useReveal<HTMLParagraphElement>();

  return (
    <section className="hero" id="top">
      <div className="wrap">
        <div className="hero__in">
          {/* Above the fold — visible immediately, not scroll-observed (matches the prototype). */}
          <div className="hero__top reveal is-in">
            <Pill>AI-powered customer support platform</Pill>
            <h1 className="h1">
              Customer support,
              <br />
              <em>connected.</em>
            </h1>
            <p className="lede">
              Serviqo brings live chat, AI assistance, tickets and your support team into one organized
              workspace.
            </p>
            <div className="hero__cta">
              <ButtonLink variant="primary" href="#pricing">
                Start supporting customers
                <ArrowRightIcon className="btn__arrow" aria-hidden="true" />
              </ButtonLink>
              <ButtonLink variant="secondary" href="#demo">
                Explore the platform
              </ButtonLink>
            </div>
            <div className="heroFeats">
              <span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4 4h16v12H8l-4 4V4Z" />
                </svg>
                Real-time messaging
              </span>
              <i className="sep" aria-hidden="true" />
              <span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9l2-6.5Z" />
                </svg>
                AI + human support
              </span>
              <i className="sep" aria-hidden="true" />
              <span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="9" cy="8" r="3" />
                  <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
                  <circle cx="17.5" cy="8.5" r="2.3" />
                  <path d="M15.8 12.2c2.4.2 4.2 2 4.2 4.6" />
                </svg>
                Built for teams
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="wrap" style={{ marginTop: 44 }}>
        <p ref={demoTitleRef} className={cn("demoTitle", "reveal", demoTitleIsIn && "is-in")}>
          One conversation. Everyone in sync.
        </p>
        <Reveal
          id="demo"
          role="img"
          aria-label="Animated demonstration of a customer chatting with Serviqo AI, which resolves part of the issue and then hands off to a human agent, whose workspace shows the same conversation with a private AI-generated brief."
          className="demoWrap"
        >
          <LiveDemo />
        </Reveal>
      </div>
    </section>
  );
}
