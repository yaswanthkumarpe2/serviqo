import { Eyebrow } from "@/components/ui/Eyebrow";
import { FeatureListItem } from "@/components/ui/FeatureListItem";
import { Reveal } from "@/components/ui/Reveal";

import "./AiHuman.css";

export function AiHuman() {
  return (
    <section className="section section--sunk" id="ai">
      <div className="wrap">
        <Reveal className="head">
          <Eyebrow>AI support</Eyebrow>
          <h2 className="h2">Two distinct jobs. Never confused.</h2>
          <p className="lede">
            Serviqo AI can talk to customers directly for approved, low-risk work — and it separately assists
            your agents behind the scenes. The two never blur together.
          </p>
        </Reveal>

        <Reveal className="aiSplit">
          <div className="aiCol aiCol--auto">
            <div className="aiCol__head">
              <span className="aiCol__icn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9l2-6.5Z" />
                </svg>
              </span>
              <h4>Autonomous AI support</h4>
            </div>
            <p className="desc">
              When an organization enables it, Serviqo AI replies to customers directly for greetings, FAQs,
              knowledge-base questions, basic troubleshooting, order status, and collecting information —
              always labeled, never disguised as a person.
            </p>
            <ul className="featlist" style={{ marginTop: 0 }}>
              <FeatureListItem>
                Every AI reply carries the <b>Serviqo AI</b> label — the customer always knows who they&rsquo;re
                talking to
              </FeatureListItem>
              <FeatureListItem>
                Identifies intent, recommends articles, creates and categorizes tickets, routes to the right
                department
              </FeatureListItem>
              <FeatureListItem>
                Hands off the moment a rule requires a person — with a private summary so the customer never
                repeats themselves
              </FeatureListItem>
            </ul>
          </div>
          <div className="aiCol aiCol--assist">
            <div className="aiCol__head">
              <span className="aiCol__icn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="4" y="5" width="16" height="12" rx="2" />
                  <path d="M9 20h6M12 17v3" />
                </svg>
              </span>
              <h4>Human agent AI assistance</h4>
            </div>
            <p className="desc">
              Inside the agent workspace, AI drafts and suggests — it never sends. Every suggestion is reviewed,
              edited or discarded by the person handling the conversation.
            </p>
            <ul className="featlist" style={{ marginTop: 0 }}>
              <FeatureListItem>Suggested replies, thread summaries, sentiment, and detected intent</FeatureListItem>
              <FeatureListItem>
                Suggested category, priority and department — applied by a human, recorded in the ticket history
              </FeatureListItem>
              <FeatureListItem>
                Relevant knowledge articles and a recommended next action, surfaced next to the reply box
              </FeatureListItem>
            </ul>
          </div>
        </Reveal>

        <Reveal className="card pad" style={{ marginTop: 16, borderColor: "var(--em-200)", background: "var(--em-50)" }}>
          <p style={{ fontSize: "13.5px" }}>
            <b>Where autonomy stops.</b> AI cannot issue refunds, change passwords, delete accounts, access
            payment credentials, or close a critical ticket — for either capability. Consequential actions
            always require a person.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
