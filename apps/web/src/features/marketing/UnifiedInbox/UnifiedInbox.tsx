import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { MessageBubble, SystemLine } from "@/components/ui/MessageBubble";
import { Reveal } from "@/components/ui/Reveal";
import { cn } from "@/utils/cn";

import "./UnifiedInbox.css";

const filters = [
  { label: "All 20", active: true },
  { label: "Mine", active: false },
  { label: "Unassigned", active: false },
  { label: "AI handling", active: false },
  { label: "Priority", active: false },
];

const rows = [
  {
    initials: "YK",
    background: "#14684A",
    name: "Yaswanth Kumar",
    time: "2m",
    preview: "Payment deducted, wallet still zero",
    badge: { variant: "danger" as const, label: "▲ HIGH" },
    selected: true,
  },
  {
    initials: "PM",
    background: "#5E6B7A",
    name: "Priya Mehta",
    time: "7m",
    preview: "Refund not received",
    badge: { variant: "warn" as const, label: "■ MEDIUM" },
    selected: false,
  },
  {
    initials: "DK",
    background: "#8B948D",
    name: "Daniel Kim",
    time: "18m",
    preview: "SSO configuration",
    badge: { variant: "em" as const, label: "AI HANDLING" },
    selected: false,
  },
];

export function UnifiedInbox() {
  return (
    <section className="section" id="inbox">
      <div className="wrap">
        <Reveal className="head">
          <Eyebrow>Unified inbox</Eyebrow>
          <h2 className="h2">One queue, every channel.</h2>
          <p className="lede">
            Web chat, email and API conversations land in the same inbox, sorted by department, priority and SLA
            — never by who happened to click first.
          </p>
        </Reveal>

        <Reveal className="inboxdemo">
          <div className="inboxdemo__list">
            <div className="inboxdemo__filters">
              {filters.map((filter) => (
                <span key={filter.label} className={cn("filterchip", filter.active && "is-on")}>
                  {filter.label}
                </span>
              ))}
            </div>
            {rows.map((row) => (
              <div key={row.name} className={cn("row", row.selected && "is-sel")}>
                <Avatar initials={row.initials} background={row.background} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "12.5px", fontWeight: 600 }}>{row.name}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)" }}>
                      {row.time}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: "11.5px",
                      color: "var(--text-3)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.preview}
                  </div>
                  <div style={{ marginTop: 5, display: "flex", gap: 5 }}>
                    <Badge variant={row.badge.variant}>{row.badge.label}</Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="inboxdemo__thread">
            <MessageBubble variant="in" meta="12:41">
              My payment was deducted but my wallet still shows zero.
            </MessageBubble>
            <MessageBubble variant="ai" tag="Serviqo AI" meta="12:41">
              I found a matching article on payment reconciliation. Would you like me to walk you through it?
            </MessageBubble>
            <SystemLine>conversation assigned to ananya rao</SystemLine>
            <MessageBubble variant="out" meta="12:43 ✓✓">
              I&rsquo;ve checked your transaction. Let me verify with our billing team.
            </MessageBubble>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
