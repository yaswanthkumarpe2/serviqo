import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";

import "./Analytics.css";

const barValues = [28, 44, 61, 52, 38, 86, 94, 79, 55, 33];
const barHours = ["09", "10", "11", "12", "13", "14", "15", "16", "17", "18"];

const metrics = [
  { label: "AI resolution rate", value: "41%" },
  { label: "Human handoff rate", value: "59%" },
  { label: "First response", value: "00:41" },
  { label: "CSAT", value: "4.7/5" },
];

export function Analytics() {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 240);
    return () => clearTimeout(timer);
  }, []);

  return (
    <section className="section section--sunk" id="analytics">
      <div className="wrap">
        <Reveal className="head">
          <Eyebrow>Analytics</Eyebrow>
          <h2 className="h2">Staffing decisions, not scoreboards.</h2>
          <p className="lede">
            See when volume actually arrives and where AI is carrying load versus handing off, with context —
            not a wall of tiles.
          </p>
        </Reveal>

        <Reveal className="card pad">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Eyebrow>Conversations per hour · today</Eyebrow>
            <Badge variant="warn">PEAK 14:00–16:00</Badge>
          </div>
          <div className="bars">
            {barValues.map((value, index) => (
              <div key={barHours[index]} className="bar">
                <i style={{ height: animated ? `${value}%` : "0%" }} />
              </div>
            ))}
          </div>
          <div className="barlabels">
            {barHours.map((hour) => (
              <span key={hour}>{hour}</span>
            ))}
          </div>
          <div className="metricrow">
            {metrics.map((metric) => (
              <div key={metric.label}>
                <small>{metric.label}</small>
                <b>{metric.value}</b>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
