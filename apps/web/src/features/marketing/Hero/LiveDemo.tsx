import { Avatar } from "@/components/ui/Avatar";
import { BrandMark, SendIcon } from "@/components/ui/icons";
import { useChatDemo } from "@/hooks/useChatDemo";

import { AiBriefPanel } from "./AiBriefPanel";
import { TimelineEntryView } from "./TimelineEntryView";

/** The two connected demo cards only — the reveal/`#demo` wrapper lives in Hero. */
export function LiveDemo() {
  const { customerTimeline, agentTimeline, aiBrief } = useChatDemo();

  return (
    <>
      <div className="demoCard">
        <div className="demoCard__head">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark width={22} height={22} />
          </span>
          <div>
            <b>Customer chat</b>
            <span>
              <i className="dot" aria-hidden="true" />
              Online
            </span>
          </div>
        </div>
        <div className="demo__body">
          {customerTimeline.map((entry) => (
            <TimelineEntryView key={entry.id} entry={entry} />
          ))}
        </div>
        <div className="demo__composer">
          <input placeholder="Type your message…" disabled />
          <span className="demo__send">
            <SendIcon />
          </span>
        </div>
      </div>

      <div className="demoArrow" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 12h16M15 7l5 5-5 5" />
          <path d="M20 12H4M9 7 4 12l5 5" />
        </svg>
      </div>

      <div className="demoCard">
        <div className="demoCard__head">
          <Avatar initials="AR" background="#14684A" size={30} />
          <div>
            <b>Ananya Rao</b>
            <span>
              <i className="dot" aria-hidden="true" />
              Billing support
            </span>
          </div>
          <div className="demoCard__meta">
            <span
              style={{
                fontSize: "11.5px",
                color: "var(--success)",
                display: "flex",
                alignItems: "center",
                gap: 5,
                justifyContent: "flex-end",
              }}
            >
              <i className="dot" aria-hidden="true" />
              Online
            </span>
          </div>
        </div>
        <div className="demoTabs">
          <span aria-current="true">Conversation</span>
          <span>Customer</span>
          <span>AI summary</span>
          <span>Ticket</span>
        </div>
        <div className="demo__body" style={{ minHeight: 200 }}>
          {agentTimeline.map((entry) => (
            <TimelineEntryView key={entry.id} entry={entry} />
          ))}
        </div>
        {aiBrief && <AiBriefPanel brief={aiBrief} />}
        <div className="demo__composer">
          <input placeholder="Type a reply…" disabled />
          <span className="demo__send">
            <SendIcon />
          </span>
        </div>
      </div>
    </>
  );
}
