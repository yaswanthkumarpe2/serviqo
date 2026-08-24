import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { fetchWidgetSettings, replaceAllowedOrigins, rotateWidgetKey } from "./widgetConfigApi";

import type { WidgetSettings } from "./widgetConfigApi";
import type { FormEvent } from "react";

import "./WidgetInstallation.css";

/**
 * Widget installation (ADR-020) — the staff surface ADR-019 §14 deferred.
 *
 * Reading the widget key, managing allowed origins, and rotating the key,
 * all behind `organization.manage` server-side. This component does not
 * gate itself on a locally-remembered role (ADR-017 §10's rule the rest of
 * the dashboard follows): it always attempts the read and renders whatever
 * the server answers, including a 403 from a role that lacks the permission.
 *
 * Mount this with `key={organizationId}` from the caller so switching the
 * active organization remounts it fresh rather than reconciling state across
 * two different tenants' settings.
 */

interface WidgetInstallationProps {
  organizationId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error"; message: string }
  | { status: "ready"; settings: WidgetSettings };

function messageFor(caught: unknown, fallback: string): string {
  if (caught instanceof AuthApiError) {
    if (caught.issues.length > 0) return caught.issues.map((issue) => issue.message).join(" ");
    return caught.message;
  }
  return fallback;
}

export function WidgetInstallation({ organizationId }: WidgetInstallationProps) {
  const { authorizedFetch } = useAuth();

  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  // The editable draft, kept as the array PUT to the server — a local add or
  // remove edits this and nothing is sent until "Save changes" is pressed.
  const [originsDraft, setOriginsDraft] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState("");
  const [isSavingOrigins, setIsSavingOrigins] = useState(false);
  const [originsError, setOriginsError] = useState<string | null>(null);
  const [originsSaved, setOriginsSaved] = useState(false);

  const [isConfirmingRotation, setIsConfirmingRotation] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const [copiedField, setCopiedField] = useState<"key" | "snippet" | null>(null);

  /*
    Runs once per mounted instance: the caller remounts this component with
    `key={organizationId}` on every organization switch (ADR-020), so this
    effect never needs to reset state for a changed id — the initial
    `useState` value above is the "loading" state a fresh mount starts in.
  */
  useEffect(() => {
    let cancelled = false;

    void fetchWidgetSettings(authorizedFetch, organizationId)
      .then((settings) => {
        if (cancelled) return;
        setLoad({ status: "ready", settings });
        setOriginsDraft(settings.allowedOrigins);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;

        // A 401 that survived authorizedFetch's retry is a sign-out already
        // in progress; ProtectedRoute redirects, so there is nothing to show.
        if (caught instanceof AuthApiError && caught.status === 401) return;

        if (caught instanceof AuthApiError && caught.status === 403) {
          setLoad({ status: "forbidden" });
          return;
        }

        setLoad({ status: "error", message: messageFor(caught, "Could not load widget installation settings.") });
      });

    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId]);

  async function copy(text: string, field: "key" | "snippet") {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 2000);
    } catch {
      // Clipboard access can be denied by the browser; the text is still
      // selectable and visible, so this is a missed convenience, not a
      // failure worth alarming over.
    }
  }

  function handleAddOrigin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = newOrigin.trim();
    if (trimmed.length === 0 || originsDraft.includes(trimmed)) return;

    setOriginsDraft((current) => [...current, trimmed]);
    setNewOrigin("");
    setOriginsSaved(false);
  }

  function handleRemoveOrigin(origin: string) {
    setOriginsDraft((current) => current.filter((entry) => entry !== origin));
    setOriginsSaved(false);
  }

  async function handleSaveOrigins() {
    setIsSavingOrigins(true);
    setOriginsError(null);
    setOriginsSaved(false);

    try {
      const settings = await replaceAllowedOrigins(authorizedFetch, organizationId, originsDraft);
      setLoad({ status: "ready", settings });
      setOriginsDraft(settings.allowedOrigins);
      setOriginsSaved(true);
    } catch (caught) {
      if (caught instanceof AuthApiError && caught.status === 401) return;
      setOriginsError(messageFor(caught, "Could not save allowed origins. Please try again."));
    } finally {
      setIsSavingOrigins(false);
    }
  }

  async function handleConfirmRotation() {
    setIsRotating(true);
    setRotateError(null);

    try {
      const settings = await rotateWidgetKey(authorizedFetch, organizationId);
      setLoad({ status: "ready", settings });
      setIsConfirmingRotation(false);
    } catch (caught) {
      if (caught instanceof AuthApiError && caught.status === 401) return;
      setRotateError(messageFor(caught, "Could not rotate the widget key. Please try again."));
    } finally {
      setIsRotating(false);
    }
  }

  if (load.status === "loading") {
    return (
      <section className="widgetInstall card pad" aria-labelledby="widget-install-heading" aria-busy="true">
        <h2 className="h3" id="widget-install-heading">
          Widget installation
        </h2>
        <p className="widgetInstall__loading" role="status">
          Loading widget installation settings…
        </p>
      </section>
    );
  }

  if (load.status === "forbidden") {
    return (
      <section className="widgetInstall card pad" aria-labelledby="widget-install-heading">
        <h2 className="h3" id="widget-install-heading">
          Widget installation
        </h2>
        <p className="widgetInstall__forbidden" role="alert">
          You do not have permission to view or manage this organization&rsquo;s widget installation. An owner or
          admin can configure it.
        </p>
      </section>
    );
  }

  if (load.status === "error") {
    return (
      <section className="widgetInstall card pad" aria-labelledby="widget-install-heading">
        <h2 className="h3" id="widget-install-heading">
          Widget installation
        </h2>
        <p className="widgetInstall__error" role="alert">
          {load.message}
        </p>
      </section>
    );
  }

  const { settings } = load;
  const embedSnippet = `<script src="${window.location.origin}/widget.js" data-serviqo-widget-key="${settings.widgetKey}" async></script>`;
  const originsChanged = JSON.stringify([...originsDraft].sort()) !== JSON.stringify([...settings.allowedOrigins].sort());

  return (
    <section className="widgetInstall card pad" aria-labelledby="widget-install-heading">
      <h2 className="h3" id="widget-install-heading">
        Widget installation
      </h2>
      <p className="widgetInstall__hint">
        Your widget key identifies this organization to Serviqo&rsquo;s chat widget. It is not a secret — it is meant
        to appear in your website&rsquo;s page source — but only the websites you allow below may use it.
      </p>

      {/* ---- widget key ---- */}
      <div className="widgetInstall__block">
        <label className="widgetInstall__label" htmlFor="widget-key">
          Widget key
        </label>
        <div className="widgetInstall__row">
          <input id="widget-key" className="widgetInstall__mono" type="text" value={settings.widgetKey} readOnly />
          <Button type="button" variant="secondary" size="sm" onClick={() => void copy(settings.widgetKey, "key")}>
            {copiedField === "key" ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>

      {/* ---- embed snippet ---- */}
      <div className="widgetInstall__block">
        <label className="widgetInstall__label" htmlFor="widget-embed-snippet">
          Embed snippet
        </label>
        <p className="widgetInstall__hint widgetInstall__hint--tight">
          Paste this into your website&rsquo;s HTML to add live chat. Messaging is still on the way — for now
          visitors will see a launcher and a ready-to-chat panel.
        </p>
        <textarea
          id="widget-embed-snippet"
          className="widgetInstall__snippet"
          value={embedSnippet}
          readOnly
          rows={2}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void copy(embedSnippet, "snippet")}
        >
          {copiedField === "snippet" ? "Copied!" : "Copy snippet"}
        </Button>
      </div>

      {/* ---- allowed origins ---- */}
      <div className="widgetInstall__block">
        <span className="widgetInstall__label">Allowed origins</span>
        <p className="widgetInstall__hint widgetInstall__hint--tight">
          Only these websites may use your widget key. An empty list means no website can — add every domain you
          install the widget on, including your local development origin if you test it there.
        </p>

        {originsDraft.length === 0 ? (
          <p className="widgetInstall__originsEmpty">No origins allowed yet.</p>
        ) : (
          <ul className="widgetInstall__origins">
            {originsDraft.map((origin) => (
              <li key={origin} className="widgetInstall__origin">
                <span className="widgetInstall__mono widgetInstall__originValue">{origin}</span>
                <button
                  type="button"
                  className="widgetInstall__originRemove"
                  onClick={() => handleRemoveOrigin(origin)}
                  aria-label={`Remove ${origin}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="widgetInstall__addOrigin" onSubmit={handleAddOrigin} noValidate>
          <label className="widgetInstall__srOnly" htmlFor="widget-new-origin">
            Add an origin
          </label>
          <input
            id="widget-new-origin"
            className="widgetInstall__input"
            type="text"
            placeholder="https://shop.example.com"
            value={newOrigin}
            onChange={(event) => setNewOrigin(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={newOrigin.trim().length === 0}>
            Add
          </Button>
        </form>

        <div className="widgetInstall__saveRow">
          <Button
            type="button"
            size="sm"
            disabled={!originsChanged || isSavingOrigins}
            onClick={() => void handleSaveOrigins()}
          >
            {isSavingOrigins ? "Saving…" : "Save changes"}
          </Button>
          {originsSaved && !originsChanged && (
            <span className="widgetInstall__saved" role="status">
              Saved.
            </span>
          )}
        </div>

        {originsError !== null && (
          <p className="widgetInstall__error" role="alert">
            {originsError}
          </p>
        )}
      </div>

      {/* ---- key rotation ---- */}
      <div className="widgetInstall__block widgetInstall__block--rotate">
        <span className="widgetInstall__label">Rotate widget key</span>
        <p className="widgetInstall__hint widgetInstall__hint--tight">
          Generates a new key and invalidates the current one immediately. Any website still embedding the old key
          will stop working until you update it.
        </p>

        {!isConfirmingRotation ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setIsConfirmingRotation(true)}>
            Rotate key
          </Button>
        ) : (
          <div className="widgetInstall__confirm" role="alertdialog" aria-labelledby="widget-rotate-confirm-heading">
            <p className="widgetInstall__confirmText" id="widget-rotate-confirm-heading">
              This immediately invalidates your current widget key. Any site still using it will stop working until
              you update the embed snippet there. This cannot be undone.
            </p>
            <div className="widgetInstall__confirmActions">
              <Button type="button" size="sm" disabled={isRotating} onClick={() => void handleConfirmRotation()}>
                {isRotating ? "Rotating…" : "Yes, rotate the key"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isRotating}
                onClick={() => setIsConfirmingRotation(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {rotateError !== null && (
          <p className="widgetInstall__error" role="alert">
            {rotateError}
          </p>
        )}
      </div>
    </section>
  );
}
