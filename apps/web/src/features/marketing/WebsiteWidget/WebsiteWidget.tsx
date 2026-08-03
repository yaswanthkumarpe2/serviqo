import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";

import "./WebsiteWidget.css";

const quickActions = ["Track an order", "Payment issue", "Talk to someone"];

export function WebsiteWidget() {
  return (
    <section className="section">
      <div className="wrap">
        <Reveal className="head head--center">
          <Eyebrow>Website widget</Eyebrow>
          <h2 className="h2">Wherever the question starts.</h2>
          <p className="lede" style={{ margin: "0 auto" }}>
            One script tag on your site, and the same AI-plus-human workspace is live.
          </p>
        </Reveal>

        <Reveal style={{ maxWidth: 640, margin: "0 auto" }}>
          <div className="browserFrame">
            <div className="browserFrame__bar">
              <span className="demo__dots">
                <i />
                <i />
                <i />
              </span>
              <span className="browserFrame__url">acme.com</span>
            </div>
            <div className="browserFrame__body">
              <div className="widgetPanel">
                <div className="widgetPanel__head">
                  <b>Acme Support</b>
                  <span>
                    <i className="dot" style={{ background: "#fff" }} aria-hidden="true" />
                    We&rsquo;re online
                  </span>
                </div>
                <div className="widgetPanel__body">
                  <p>Hi 👋 How can we help today?</p>
                  {quickActions.map((action) => (
                    <button key={action} type="button">
                      {action}
                    </button>
                  ))}
                </div>
              </div>
              <span className="launcher">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
                  <path d="M4 4h16v12H8l-4 4V4Z" />
                </svg>
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
