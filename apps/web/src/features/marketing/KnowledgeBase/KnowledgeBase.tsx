import { Eyebrow } from "@/components/ui/Eyebrow";
import { FeatureListItem } from "@/components/ui/FeatureListItem";
import { Reveal } from "@/components/ui/Reveal";
import { SearchIcon } from "@/components/ui/icons";

import "./KnowledgeBase.css";

const results = [
  {
    title: "Why a successful payment might not reflect immediately",
    description: "Reconciliation timing, common causes, and what to check first.",
  },
  {
    title: "Requesting a refund for a duplicate charge",
    description: "Step-by-step, including expected turnaround time.",
  },
];

function DocumentIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 3v5h5" />
      <path d="M14 3H6v18h12V8l-4-5Z" />
    </svg>
  );
}

export function KnowledgeBase() {
  return (
    <section className="section" id="kb">
      <div className="wrap split split--flip">
        <Reveal className="split__media">
          <div className="card pad">
            <div className="kbSearch">
              <SearchIcon style={{ color: "var(--text-3)" }} aria-hidden="true" />
              <input placeholder="payment failed" disabled />
            </div>
            {results.map((result) => (
              <div key={result.title} className="kbResult">
                <span className="kbResult__icn">
                  <DocumentIcon />
                </span>
                <div>
                  <b>{result.title}</b>
                  <p>{result.description}</p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal>
          <Eyebrow>Knowledge base</Eyebrow>
          <h2 className="h2" style={{ margin: "12px 0 14px" }}>
            The answer, before the ticket.
          </h2>
          <p className="lede">
            Customers see matching articles before they&rsquo;re prompted to open a conversation. Agents search
            the same library without leaving the thread — type{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "12.5px",
                background: "var(--surface-sunk)",
                padding: "1px 5px",
                borderRadius: 4,
              }}
            >
              /kb
            </code>{" "}
            and results appear inline.
          </p>
          <ul className="featlist">
            <FeatureListItem>
              Articles, collections, drafts and published states, with view and helpfulness counts
            </FeatureListItem>
            <FeatureListItem>
              Powers both customer self-service and AI-suggested replies from the same source
            </FeatureListItem>
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
