import type { WidgetAppearance } from "./types";

/**
 * Business hours, worked out in the browser (ADR-040 §2).
 *
 * The same rule the server applies, restated because the widget bundle shares
 * no code with the server (ADR-021 §2). The server's answer arrives with the
 * session; this recomputes it when presence changes or an hour boundary passes
 * without another request.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isWithinBusinessHours(hours: WidgetAppearance["businessHours"] | undefined, now: Date = new Date()): boolean {
  if (hours === undefined || !hours.enabled) return true;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return true;
  }

  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const day = hours.days[WEEKDAYS.indexOf(weekday)];
  if (day === null || day === undefined) return false;

  const current = `${hour === "24" ? "00" : hour}:${minute}`;
  return current >= day.open && current < day.close;
}

/** A slightly darker shade of a `#RRGGBB` colour, for hover states. */
export function darken(hex: string, amount = 0.2): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) return hex;
  const value = Number.parseInt(match[1]!, 16);
  const channel = (shift: number) => Math.max(0, Math.round(((value >> shift) & 0xff) * (1 - amount)));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}
