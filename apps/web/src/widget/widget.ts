import { openWidgetSession, WidgetSessionError } from "./session";
import { loadStoredToken, storeToken } from "./storage";
import { WIDGET_STYLES } from "./styles";
import { createLauncher, createPanelSkeleton } from "./ui";

import type { WidgetConfig, WidgetSessionCustomer } from "./types";

/**
 * Mounts the widget and wires its interactions (ADR-021 §3, §7, §8, §9).
 *
 * Structured as a function that returns a `{ destroy }` handle rather than a
 * top-level side effect, so it is directly unit-testable under `jsdom`
 * without loading the bundled entry point, and so a caller can tear one
 * mount down cleanly (ADR-021 §9).
 */

export interface WidgetHandle {
  destroy(): void;
}

type PanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; customer: WidgetSessionCustomer; token: string }
  | { status: "error"; message: string };

/**
 * Mounts the widget into `document.body`, or returns `null` without
 * touching the DOM if Shadow DOM is unavailable (ADR-021 §3's graceful
 * absence: a missing widget beats unscoped CSS on a page Serviqo does not
 * own).
 */
export function initWidget(config: WidgetConfig): WidgetHandle | null {
  if (typeof document.createElement("div").attachShadow !== "function") {
    console.warn("Serviqo widget: this browser does not support Shadow DOM; the widget was not mounted.");
    return null;
  }

  const host = document.createElement("div");
  host.setAttribute("data-serviqo-widget-host", "true");
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = WIDGET_STYLES;
  shadow.appendChild(styleEl);

  const root = document.createElement("div");
  root.className = "root";
  shadow.appendChild(root);

  const launcher = createLauncher();
  const panel = createPanelSkeleton("serviqo-widget-title");
  root.append(panel.element, launcher);

  let state: PanelState = { status: "idle" };
  let isOpen = false;

  function setState(next: PanelState) {
    state = next;
    renderBody();
  }

  // ---- state → DOM ----

  function renderBody() {
    panel.body.replaceChildren();

    if (state.status === "idle" || state.status === "loading") {
      panel.body.appendChild(renderLoading());
      return;
    }

    if (state.status === "error") {
      panel.body.appendChild(renderError(state.message));
      return;
    }

    panel.body.appendChild(renderReady(state.customer));
  }

  function renderLoading(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "state";
    wrap.setAttribute("role", "status");
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    const label = document.createElement("p");
    label.textContent = "Connecting…";
    wrap.append(spinner, label);
    return wrap;
  }

  function renderError(message: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "state error";
    wrap.setAttribute("role", "alert");
    const heading = document.createElement("h3");
    heading.textContent = "We couldn't connect";
    const text = document.createElement("p");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      void openSession();
    });
    wrap.append(heading, text, retry);
    return wrap;
  }

  function renderReady(customer: WidgetSessionCustomer): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "state";
    const heading = document.createElement("h3");
    heading.textContent = "How can we help?";
    const text = document.createElement("p");
    text.textContent = "Chat is ready. Our support team is ready to assist you.";
    wrap.append(heading, text);

    if (customer.name !== null || customer.email !== null) {
      const thanks = document.createElement("p");
      thanks.className = "thanks";
      thanks.textContent =
        customer.name !== null ? `Thanks, ${customer.name} — we have your details.` : "Thanks — we have your details.";
      wrap.appendChild(thanks);
      return wrap;
    }

    wrap.appendChild(renderDetailsForm());
    return wrap;
  }

  function renderDetailsForm(): HTMLElement {
    const details = document.createElement("details");
    details.className = "details";
    const summary = document.createElement("summary");
    summary.textContent = "Share your name and email (optional)";
    details.appendChild(summary);

    const form = document.createElement("form");
    form.noValidate = true;

    const nameField = createField("serviqo-widget-name", "Name", "text");
    const emailField = createField("serviqo-widget-email", "Email", "email");
    form.append(nameField.wrap, emailField.wrap);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "submit";
    submit.textContent = "Save";
    form.appendChild(submit);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = nameField.input.value.trim();
      const email = emailField.input.value.trim();
      if (name.length === 0 && email.length === 0) return;

      submit.disabled = true;
      void submitDetails(name.length > 0 ? name : undefined, email.length > 0 ? email : undefined).finally(() => {
        submit.disabled = false;
      });
    });

    details.appendChild(form);
    return details;
  }

  function createField(id: string, labelText: string, type: string) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.setAttribute("for", id);
    label.textContent = labelText;
    const input = document.createElement("input");
    input.id = id;
    input.type = type;
    input.autocomplete = type === "email" ? "email" : "name";
    wrap.append(label, input);
    return { wrap, input };
  }

  // ---- network calls ----

  async function openSession() {
    setState({ status: "loading" });

    const visitorToken = loadStoredToken(config.widgetKey) ?? undefined;

    try {
      const result = await openWidgetSession(config.apiBase, {
        widgetKey: config.widgetKey,
        ...(visitorToken !== undefined ? { visitorToken } : {}),
      });
      storeToken(config.widgetKey, result.token);
      setState({ status: "ready", customer: result.customer, token: result.token });
    } catch (error) {
      const message = error instanceof WidgetSessionError ? error.message : "Chat is not available right now.";
      setState({ status: "error", message });
    }
  }

  async function submitDetails(name: string | undefined, email: string | undefined) {
    if (state.status !== "ready") return;

    try {
      const result = await openWidgetSession(config.apiBase, {
        widgetKey: config.widgetKey,
        visitorToken: state.token,
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email } : {}),
      });
      storeToken(config.widgetKey, result.token);
      setState({ status: "ready", customer: result.customer, token: result.token });
    } catch {
      // The customer's existing session stays usable; only the detail
      // update failed. Nothing in the ready state needs to change to show
      // this — a visitor who cares will simply try again.
    }
  }

  // ---- open / close ----

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && isOpen) close();
  }

  function open() {
    isOpen = true;
    panel.element.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKeyDown);
    panel.closeButton.focus();

    if (state.status === "idle") void openSession();
  }

  function close() {
    isOpen = false;
    panel.element.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKeyDown);
    launcher.focus();
  }

  launcher.addEventListener("click", () => {
    if (isOpen) close();
    else open();
  });
  panel.closeButton.addEventListener("click", close);

  renderBody();
  document.body.appendChild(host);

  function destroy() {
    document.removeEventListener("keydown", onKeyDown);
    host.remove();
  }

  return { destroy };
}
