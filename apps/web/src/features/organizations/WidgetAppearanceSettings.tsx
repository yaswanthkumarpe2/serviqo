import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { WidgetIcon } from "@/features/workspace/workspaceIcons";

import { fetchWidgetSettings, updateWidgetAppearance } from "./widgetConfigApi";

import type { BusinessDay, WidgetAppearance } from "./widgetConfigApi";
import type { FormEvent } from "react";

import "./WidgetAppearanceSettings.css";

/**
 * How the customer chat looks, and when it says the team is available
 * (ADR-040 §1–2).
 *
 * One form for the organisation's colour, chat title, the two messages
 * visitors see, and weekly business hours, with a preview that updates as the
 * admin types. Saving needs `organization.manage`; a role without it sees the
 * server's refusal, the same way the embed settings beside it do.
 */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DEFAULT_APPEARANCE: WidgetAppearance = {
  accentColor: "#14684A",
  title: null,
  welcomeMessage: null,
  awayMessage: null,
  businessHours: {
    enabled: false,
    timezone: "UTC",
    days: [null, ...Array.from({ length: 5 }, () => ({ open: "09:00", close: "17:00" })), null],
  },
};

const SWATCHES = ["#14684A", "#2563EB", "#7C3AED", "#DB2777", "#EA580C", "#0F172A"];

function timezones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    if (typeof supported === "function") return supported("timeZone");
  } catch {
    // Older browsers: fall through to a short list.
  }
  return ["UTC", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type LoadState = { status: "loading" } | { status: "forbidden" } | { status: "error" } | { status: "ready" };

export function WidgetAppearanceSettings({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const { authorizedFetch } = useAuth();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<WidgetAppearance>(DEFAULT_APPEARANCE);
  const [saved, setSaved] = useState<WidgetAppearance>(DEFAULT_APPEARANCE);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewOnline, setPreviewOnline] = useState(true);
  const zones = useMemo(() => timezones(), []);
  const baseId = useId();

  useEffect(() => {
    let cancelled = false;
    fetchWidgetSettings(authorizedFetch, organizationId)
      .then((settings) => {
        if (cancelled) return;
        const appearance = settings.appearance ?? DEFAULT_APPEARANCE;
        setDraft(appearance);
        setSaved(appearance);
        setLoad({ status: "ready" });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof AuthApiError && caught.status === 401) return;
        setLoad({ status: caught instanceof AuthApiError && caught.status === 403 ? "forbidden" : "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function update(patch: Partial<WidgetAppearance>) {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice(null);
  }

  function updateHours(patch: Partial<WidgetAppearance["businessHours"]>) {
    setDraft((current) => ({ ...current, businessHours: { ...current.businessHours, ...patch } }));
    setNotice(null);
  }

  function updateDay(index: number, day: BusinessDay | null) {
    setDraft((current) => {
      const days = [...current.businessHours.days];
      days[index] = day;
      return { ...current, businessHours: { ...current.businessHours, days } };
    });
    setNotice(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    updateWidgetAppearance(authorizedFetch, organizationId, draft)
      .then((settings) => {
        const appearance = settings.appearance ?? draft;
        setDraft(appearance);
        setSaved(appearance);
        setNotice("Saved. Visitors see the new look the next time the chat opens.");
      })
      .catch((caught: unknown) => {
        if (caught instanceof AuthApiError && caught.issues.length > 0) {
          setError(caught.issues.map((issue) => `${issue.field}: ${issue.message}`).join(" "));
        } else if (caught instanceof AuthApiError && caught.status === 403) {
          setError("Your role cannot change the chat's appearance.");
        } else {
          setError("Could not save. Please try again.");
        }
      })
      .finally(() => setIsSaving(false));
  }

  if (load.status === "loading") {
    return (
      <section className="appearance card pad">
        <p className="appearance__state" role="status">
          Loading chat appearance…
        </p>
      </section>
    );
  }

  if (load.status === "forbidden") {
    // Agents can see and share the chat link, but its look is an admin's decision.
    return null;
  }

  if (load.status === "error") {
    return (
      <section className="appearance card pad">
        <p className="appearance__state" role="alert">
          Could not load the chat&rsquo;s appearance.
        </p>
      </section>
    );
  }

  const title = draft.title ?? organizationName;
  const subtitle = previewOnline
    ? (draft.welcomeMessage ?? "We usually reply within a few minutes.")
    : (draft.awayMessage ?? "We're away right now. Leave a message and we'll reply here.");

  return (
    <section className="appearance card pad" aria-labelledby={`${baseId}-heading`}>
      <div className="appearance__head">
        <span className="appearance__icon" aria-hidden="true">
          <WidgetIcon />
        </span>
        <div>
          <h2 className="h3" id={`${baseId}-heading`}>
            Chat appearance &amp; hours
          </h2>
          <p className="appearance__hint">What customers see when they open your chat link or website widget.</p>
        </div>
      </div>

      <div className="appearance__layout">
        <form className="appearance__form" onSubmit={handleSubmit} noValidate>
          <fieldset className="appearance__fieldset">
            <legend className="appearance__legend">Look</legend>

            <label className="appearance__label" htmlFor={`${baseId}-color`}>
              Brand colour
            </label>
            <div className="appearance__colorRow">
              <input
                id={`${baseId}-color`}
                type="color"
                className="appearance__colorInput"
                value={draft.accentColor}
                onChange={(event) => update({ accentColor: event.target.value.toUpperCase() })}
              />
              <input
                type="text"
                className="appearance__input appearance__input--mono"
                aria-label="Brand colour hex value"
                value={draft.accentColor}
                maxLength={7}
                onChange={(event) => update({ accentColor: event.target.value })}
              />
              <span className="appearance__swatches">
                {SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    className="appearance__swatch"
                    style={{ background: swatch }}
                    aria-label={`Use ${swatch}`}
                    aria-pressed={draft.accentColor.toUpperCase() === swatch}
                    onClick={() => update({ accentColor: swatch })}
                  />
                ))}
              </span>
            </div>

            <label className="appearance__label" htmlFor={`${baseId}-title`}>
              Chat title
            </label>
            <input
              id={`${baseId}-title`}
              className="appearance__input"
              maxLength={60}
              placeholder={organizationName}
              value={draft.title ?? ""}
              onChange={(event) => update({ title: event.target.value === "" ? null : event.target.value })}
            />

            <label className="appearance__label" htmlFor={`${baseId}-welcome`}>
              Message while you&rsquo;re available
            </label>
            <input
              id={`${baseId}-welcome`}
              className="appearance__input"
              maxLength={200}
              placeholder="We usually reply within a few minutes."
              value={draft.welcomeMessage ?? ""}
              onChange={(event) => update({ welcomeMessage: event.target.value === "" ? null : event.target.value })}
            />

            <label className="appearance__label" htmlFor={`${baseId}-away`}>
              Message while you&rsquo;re away
            </label>
            <input
              id={`${baseId}-away`}
              className="appearance__input"
              maxLength={200}
              placeholder="We're away right now. Leave a message and we'll reply here."
              value={draft.awayMessage ?? ""}
              onChange={(event) => update({ awayMessage: event.target.value === "" ? null : event.target.value })}
            />
          </fieldset>

          <fieldset className="appearance__fieldset">
            <legend className="appearance__legend">Business hours</legend>

            <label className="appearance__check">
              <input
                type="checkbox"
                checked={draft.businessHours.enabled}
                onChange={(event) =>
                  updateHours({
                    enabled: event.target.checked,
                    // A first-time switch-on starts in the admin's own timezone.
                    ...(event.target.checked && draft.businessHours.timezone === "UTC" ? { timezone: browserTimezone() } : {}),
                  })
                }
              />
              <span>Only show as available during business hours</span>
            </label>

            {draft.businessHours.enabled && (
              <>
                <label className="appearance__label" htmlFor={`${baseId}-tz`}>
                  Timezone
                </label>
                <select
                  id={`${baseId}-tz`}
                  className="appearance__input"
                  value={draft.businessHours.timezone}
                  onChange={(event) => updateHours({ timezone: event.target.value })}
                >
                  {(zones.includes(draft.businessHours.timezone) ? zones : [draft.businessHours.timezone, ...zones]).map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>

                <div className="appearance__days">
                  {DAYS.map((dayName, index) => {
                    const day = draft.businessHours.days[index] ?? null;
                    return (
                      <div className="appearance__day" key={dayName}>
                        <label className="appearance__check appearance__dayName">
                          <input
                            type="checkbox"
                            checked={day !== null}
                            onChange={(event) =>
                              updateDay(index, event.target.checked ? { open: "09:00", close: "17:00" } : null)
                            }
                          />
                          <span>{dayName}</span>
                        </label>
                        {day === null ? (
                          <span className="appearance__closed">Closed</span>
                        ) : (
                          <span className="appearance__times">
                            <input
                              type="time"
                              className="appearance__input appearance__input--time"
                              aria-label={`${dayName} opens`}
                              value={day.open}
                              onChange={(event) => updateDay(index, { ...day, open: event.target.value })}
                            />
                            <span aria-hidden="true">–</span>
                            <input
                              type="time"
                              className="appearance__input appearance__input--time"
                              aria-label={`${dayName} closes`}
                              value={day.close}
                              onChange={(event) => updateDay(index, { ...day, close: event.target.value })}
                            />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </fieldset>

          {error !== null && (
            <p className="appearance__error" role="alert">
              {error}
            </p>
          )}
          {notice !== null && (
            <p className="appearance__notice" role="status">
              {notice}
            </p>
          )}

          <div className="appearance__actions">
            <Button type="submit" variant="primary" disabled={isSaving || !isDirty}>
              {isSaving ? "Saving…" : "Save changes"}
            </Button>
            {isDirty && (
              <Button type="button" variant="secondary" onClick={() => setDraft(saved)} disabled={isSaving}>
                Discard
              </Button>
            )}
          </div>
        </form>

        <div className="appearance__preview" aria-label="Preview">
          <div className="appearance__previewToggle" role="group" aria-label="Preview state">
            <button type="button" aria-pressed={previewOnline} onClick={() => setPreviewOnline(true)}>
              Available
            </button>
            <button type="button" aria-pressed={!previewOnline} onClick={() => setPreviewOnline(false)}>
              Away
            </button>
          </div>
          <div className="appearance__phone">
            <div className="appearance__phoneHeader" style={{ background: draft.accentColor }}>
              <strong>{title}</strong>
              <span className="appearance__phoneSubtitle">
                <i className={previewOnline ? "appearance__dot appearance__dot--on" : "appearance__dot"} />
                {subtitle}
              </span>
            </div>
            <div className="appearance__phoneBody">
              <span className="appearance__bubble appearance__bubble--customer">Hi, can you help with my order?</span>
              <span className="appearance__bubble appearance__bubble--agent" style={{ background: draft.accentColor }}>
                Of course! What&rsquo;s your order number?
              </span>
            </div>
            <div className="appearance__phoneComposer">
              <span>Type your message…</span>
              <span className="appearance__phoneSend" style={{ background: draft.accentColor }}>
                Send
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
