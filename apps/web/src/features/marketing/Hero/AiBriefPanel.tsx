import { useEffect, useState } from "react";

import { MiniButton } from "@/components/ui/MiniButton";
import { SparkIcon } from "@/components/ui/icons";

import type { AiBrief } from "@/hooks/useChatDemo";

interface AiBriefPanelProps {
  brief: AiBrief;
}

/** Private, agent-only AI summary panel — never visible in the customer pane. */
export function AiBriefPanel({ brief }: AiBriefPanelProps) {
  const [fillWidth, setFillWidth] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setFillWidth(brief.confidence), 120);
    return () => clearTimeout(timer);
  }, [brief.confidence]);

  return (
    <div className="demo__aiPanel">
      <div className="msg__tag">
        <SparkIcon width={10} height={10} aria-hidden="true" />
        AI summary
      </div>
      <div className="aiPrivacy">Private · visible only to agents</div>
      <div className="aiFields">
        <div className="full">
          <span>Summary</span>
          <b style={{ fontWeight: 500 }}>{brief.summary}</b>
        </div>
        <div>
          <span>Intent</span>
          <b>{brief.intent}</b>
        </div>
        <div>
          <span>Sentiment</span>
          <b>
            <span className="sentiDot" aria-hidden="true" />
            {brief.sentiment}
          </b>
        </div>
        <div className="full">
          <span>Suggested action</span>
          <b style={{ fontWeight: 500 }}>{brief.suggestedAction}</b>
        </div>
        <div className="full">
          <span>Knowledge used</span>
          <span className="kbPill">{brief.knowledgeUsed}</span>
        </div>
      </div>
      <div className="confBar">
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9.5px",
            textTransform: "uppercase",
            letterSpacing: ".06em",
            color: "var(--text-3)",
          }}
        >
          Confidence · {brief.confidence}%
        </span>
        <div className="confBar__track">
          <div className="confBar__fill" style={{ width: `${fillWidth}%` }} />
        </div>
      </div>
      <div className="aiActs" style={{ marginTop: 12 }}>
        <MiniButton filled>Insert suggested reply</MiniButton>
        <MiniButton>View full summary</MiniButton>
      </div>
    </div>
  );
}
