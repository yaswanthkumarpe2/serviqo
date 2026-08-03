import { Eyebrow } from "@/components/ui/Eyebrow";
import { FeatureListItem } from "@/components/ui/FeatureListItem";
import { MiniButton } from "@/components/ui/MiniButton";
import { Reveal } from "@/components/ui/Reveal";

import "./Automation.css";

interface ConditionRow {
  subject: string;
  operator?: string;
  value?: string;
}

const whenRows: ConditionRow[] = [{ subject: "A new conversation arrives" }];
const ifRows: ConditionRow[] = [
  { subject: "Department", operator: "is", value: "Billing" },
  { subject: "Language", operator: "is", value: "English" },
];
const thenRows: ConditionRow[] = [
  { subject: "Assign to", operator: "→", value: "Billing team" },
  { subject: "Send message", operator: "→", value: "Welcome template" },
];

function ConditionRowView({ row }: { row: ConditionRow }) {
  return (
    <div className="condRow">
      <b>{row.subject}</b>
      {row.operator && (
        <>
          <span>{row.operator}</span>
          <b>{row.value}</b>
        </>
      )}
    </div>
  );
}

export function Automation() {
  return (
    <section className="section section--sunk" id="automation">
      <div className="wrap split">
        <Reveal>
          <Eyebrow>Automation — separate from AI</Eyebrow>
          <h2 className="h2" style={{ margin: "12px 0 14px" }}>
            Deterministic messages don&rsquo;t need a model.
          </h2>
          <p className="lede">
            Welcome messages, business-hours replies, queue position, ticket-created confirmations and SLA
            notifications run on Serviqo&rsquo;s rules engine — instant, predictable, and consuming zero AI
            calls.
          </p>
          <ul className="featlist">
            <FeatureListItem>
              Rules read as sentences — <b>when / if / then</b> — not a node canvas nobody wants to debug at 2am
            </FeatureListItem>
            <FeatureListItem>
              Dry-run preview shows exactly what a rule would have matched before you turn it on
            </FeatureListItem>
            <FeatureListItem>Runs whether or not AI is enabled for the organization</FeatureListItem>
          </ul>
        </Reveal>

        <Reveal className="split__media">
          <div className="autoCard">
            <div className="autoCard__head">
              <b>Route billing to specialists</b>
              <span className="toggle" aria-hidden="true">
                <i />
              </span>
            </div>
            <div className="autoCard__body">
              <div className="autoLine">
                <span className="eyebrow">When</span>
                {whenRows.map((row) => (
                  <ConditionRowView key={row.subject} row={row} />
                ))}
              </div>
              <div className="autoLine">
                <span className="eyebrow">If</span>
                {ifRows.map((row) => (
                  <ConditionRowView key={row.subject} row={row} />
                ))}
              </div>
              <div className="autoLine" style={{ marginBottom: 0 }}>
                <span className="eyebrow">Then</span>
                {thenRows.map((row) => (
                  <ConditionRowView key={row.subject} row={row} />
                ))}
              </div>
            </div>
            <div className="autoFoot">
              <span>Matched 214 conversations in the last 7 days</span>
              <MiniButton filled>Save rule</MiniButton>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
