/**
 * How an organisation's customer chat looks and when it says it is open
 * (ADR-040 §1–2).
 *
 * Public by design: everything here is shown to anyone who opens the chat link,
 * so nothing here may ever be a secret or name a member of staff.
 */

export interface BusinessHoursDay {
  /** "HH:MM", 24-hour, in the organisation's timezone. */
  open: string;
  close: string;
}

export interface BusinessHours {
  enabled: boolean;
  /** IANA timezone, e.g. "Asia/Kolkata". */
  timezone: string;
  /** Sunday first. `null` means closed all day. */
  days: (BusinessHoursDay | null)[];
}

export interface WidgetAppearance {
  /** "#RRGGBB". */
  accentColor: string;
  /** The chat's heading. `null` uses the organisation's name. */
  title: string | null;
  /** Shown under the heading while someone is available. */
  welcomeMessage: string | null;
  /** Shown while nobody is available or outside business hours. */
  awayMessage: string | null;
  businessHours: BusinessHours;
}

export const DEFAULT_ACCENT_COLOR = "#14684A";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function defaultBusinessHours(): BusinessHours {
  const weekday = { open: "09:00", close: "17:00" };
  return {
    enabled: false,
    timezone: "UTC",
    days: [null, weekday, weekday, weekday, weekday, weekday, null],
  };
}

export function defaultAppearance(): WidgetAppearance {
  return {
    accentColor: DEFAULT_ACCENT_COLOR,
    title: null,
    welcomeMessage: null,
    awayMessage: null,
    businessHours: defaultBusinessHours(),
  };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `now` falls inside the organisation's business hours.
 *
 * Always true when hours are disabled: an organisation that set none is open
 * whenever someone is signed in. An invalid stored timezone is treated as
 * open rather than throwing on a public request.
 */
export function isWithinBusinessHours(hours: BusinessHours | undefined | null, now: Date = new Date()): boolean {
  if (hours === undefined || hours === null || !hours.enabled) return true;

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
  const dayIndex = WEEKDAYS.indexOf(weekday);
  const day = dayIndex === -1 ? null : hours.days[dayIndex];
  if (day === null || day === undefined) return false;

  const current = `${hour === "24" ? "00" : hour}:${minute}`;
  return current >= day.open && current < day.close;
}

/**
 * What a visitor is told about availability right now.
 *
 * `online` is the one fact the widget acts on: somebody is signed in to answer
 * AND it is within business hours. The two inputs are returned too, so a
 * widget can recompute when either changes without another request.
 */
export function availabilityFor(appearance: WidgetAppearance, agentsOnline: boolean, now: Date = new Date()) {
  const withinBusinessHours = isWithinBusinessHours(appearance.businessHours, now);
  return { online: agentsOnline && withinBusinessHours, agentsOnline, withinBusinessHours };
}

/** The stored appearance with defaults filled in, for documents written before it existed. */
export function appearanceOf(stored: Partial<WidgetAppearance> | null | undefined): WidgetAppearance {
  const defaults = defaultAppearance();
  if (stored === null || stored === undefined) return defaults;
  const hours = stored.businessHours;
  return {
    accentColor: stored.accentColor ?? defaults.accentColor,
    title: stored.title ?? null,
    welcomeMessage: stored.welcomeMessage ?? null,
    awayMessage: stored.awayMessage ?? null,
    businessHours:
      hours === undefined || hours === null
        ? defaults.businessHours
        : {
            enabled: hours.enabled ?? false,
            timezone: hours.timezone ?? "UTC",
            days: Array.from({ length: 7 }, (_, index) => {
              const day = hours.days?.[index];
              return day === null || day === undefined ? null : { open: day.open, close: day.close };
            }),
          },
  };
}

/** What a visitor's chat needs to draw itself (ADR-040 §1). */
export function toPublicChatSettings(
  organization: { name: string; widgetAppearance?: Partial<WidgetAppearance> | null },
  agentsOnline: boolean,
  now: Date = new Date(),
) {
  const appearance = appearanceOf(organization.widgetAppearance);
  return {
    appearance: { ...appearance, title: appearance.title ?? organization.name },
    availability: availabilityFor(appearance, agentsOnline, now),
  };
}
