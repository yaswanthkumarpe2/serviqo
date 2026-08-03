import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { FeatureListItem } from "@/components/ui/FeatureListItem";
import { Reveal } from "@/components/ui/Reveal";
import type { BadgeVariant } from "@/components/ui/Badge";

import "./Ticketing.css";

const tickets: {
  id: string;
  subject: string;
  meta: string;
  badges: { variant: BadgeVariant; label: string }[];
}[] = [
  {
    id: "SRV-10482",
    subject: "Payment deducted, wallet not credited",
    meta: "Yaswanth Kumar · Billing · Ananya Rao",
    badges: [
      { variant: "danger", label: "URGENT" },
      { variant: "em", label: "IN PROGRESS" },
    ],
  },
  {
    id: "SRV-10479",
    subject: "Refund not received after 5 days",
    meta: "Priya Mehta · Refunds · Rahul Sharma",
    badges: [
      { variant: "warn", label: "HIGH" },
      { variant: "neutral", label: "WAITING" },
    ],
  },
  {
    id: "SRV-10475",
    subject: "SSO configuration for workspace",
    meta: "Daniel Kim · Technical · AI handling",
    badges: [
      { variant: "neutral", label: "LOW" },
      { variant: "em", label: "OPEN" },
    ],
  },
];

export function Ticketing() {
  return (
    <section className="section" id="tickets">
      <div className="wrap split split--flip">
        <Reveal className="split__media">
          <div className="card" style={{ overflow: "hidden" }}>
            {tickets.map((ticket) => (
              <div key={ticket.id} className="ticket">
                <span className="ticket__id">{ticket.id}</span>
                <div>
                  <div className="ticket__sub">{ticket.subject}</div>
                  <div className="ticket__meta">{ticket.meta}</div>
                </div>
                <div className="ticket__right">
                  {ticket.badges.map((badge) => (
                    <Badge key={badge.label} variant={badge.variant}>
                      {badge.label}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal>
          <Eyebrow>Ticketing and SLA</Eyebrow>
          <h2 className="h2" style={{ margin: "12px 0 14px" }}>
            A clock on every promise you make.
          </h2>
          <p className="lede">
            Any conversation can become a ticket with a number, an owner and a deadline. Response and
            resolution targets are set per priority, and agents are warned before the timer runs out.
          </p>
          <ul className="featlist">
            <FeatureListItem>
              <b>Nine states, one lifecycle.</b> Open through reopened, with the full activity history attached.
            </FeatureListItem>
            <FeatureListItem>
              <b>Departments and skills.</b> Billing, refunds, technical, security — agents belong to the teams
              they know.
            </FeatureListItem>
            <FeatureListItem>
              <b>AI-suggested category and priority</b>, applied by a human and logged as such.
            </FeatureListItem>
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
