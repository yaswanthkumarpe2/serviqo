/**
 * Static DOM builders: the pieces of the widget that do not change shape
 * across states (ADR-021 §8). State-dependent content is built in
 * `widget.ts`, which owns the panel body.
 */

const CHAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M4 12a8 8 0 1 1 3.2 6.4L4 20l1.2-3.6A7.96 7.96 0 0 1 4 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
  "</svg>";

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  "</svg>";

/**
 * The floating launcher. `aria-expanded` is kept in sync by the caller on
 * every open/close, and the icon is static markup — an inert pictogram, not
 * user data, so `innerHTML` here carries nothing a visitor typed.
 */
export function createLauncher(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "launcher";
  button.setAttribute("aria-label", "Open chat");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = CHAT_ICON;
  return button;
}

export interface PanelSkeleton {
  element: HTMLDivElement;
  body: HTMLDivElement;
  closeButton: HTMLButtonElement;
  titleId: string;
}

/**
 * The panel's frame: header (title, subtitle, close button) and an empty
 * body the caller fills per state. Hidden by default via the `hidden`
 * attribute, which `.panel[hidden]` in `styles.ts` backs with `display:none`
 * — belt and braces against a host page's own `[hidden]` reset, which cannot
 * reach through the shadow boundary anyway (ADR-021 §3), but costs nothing.
 */
export function createPanelSkeleton(titleId: string): PanelSkeleton {
  const element = document.createElement("div");
  element.className = "panel";
  element.hidden = true;
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.setAttribute("aria-labelledby", titleId);

  const header = document.createElement("div");
  header.className = "panel__header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.className = "panel__title";
  title.id = titleId;
  title.textContent = "Chat with us";
  const subtitle = document.createElement("p");
  subtitle.className = "panel__subtitle";
  subtitle.textContent = "We usually reply within a few minutes.";
  titleWrap.append(title, subtitle);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "panel__close";
  closeButton.setAttribute("aria-label", "Close chat");
  closeButton.innerHTML = CLOSE_ICON;

  header.append(titleWrap, closeButton);

  const body = document.createElement("div");
  body.className = "panel__body";

  element.append(header, body);

  return { element, body, closeButton, titleId };
}

/**
 * The chat surface: a scrolling message list and a composer (ADR-024 §10).
 *
 * `role="log"` with `aria-live="polite"` so a delivered message is announced
 * without stealing focus from the composer — the correct pairing for an
 * incoming-message surface, and why this is not `assertive`.
 */
export interface ChatSurface {
  element: HTMLDivElement;
  list: HTMLDivElement;
  status: HTMLParagraphElement;
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  notice: HTMLParagraphElement;
}

export function createChatSurface(maxBodyLength: number): ChatSurface {
  const element = document.createElement("div");
  element.className = "chat";

  const list = document.createElement("div");
  list.className = "chat__list";
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");
  list.setAttribute("aria-label", "Conversation");

  const status = document.createElement("p");
  status.className = "chat__status";
  status.setAttribute("role", "status");

  const form = document.createElement("form");
  form.className = "chat__composer";
  form.noValidate = true;

  const label = document.createElement("label");
  label.className = "sr-only";
  label.setAttribute("for", "serviqo-widget-composer");
  label.textContent = "Type your message";

  const input = document.createElement("textarea");
  input.id = "serviqo-widget-composer";
  input.className = "chat__input";
  input.rows = 1;
  input.placeholder = "Type your message…";
  /*
    A courtesy bound that prevents a doomed round trip, never a validation
    boundary (ADR-024 §11): the server still enforces this at the Zod schema
    AND at the Message model (ADR-022 §9), and an over-length body is still
    rejected there rather than truncated.
  */
  input.maxLength = maxBodyLength;

  const sendButton = document.createElement("button");
  sendButton.type = "submit";
  sendButton.className = "chat__send";
  sendButton.textContent = "Send";

  form.append(label, input, sendButton);

  const notice = document.createElement("p");
  notice.className = "chat__notice";
  notice.setAttribute("role", "alert");
  notice.hidden = true;

  element.append(list, notice, status, form);

  return { element, list, status, form, input, sendButton, notice };
}

/**
 * Renders one message bubble.
 *
 * The body is written with `textContent`, never `innerHTML` — ADR-022 §9
 * assigned this obligation to the consuming component explicitly ("rendering
 * it as text rather than markup is the consuming component's obligation,
 * stated explicitly here so it is not rediscovered as an XSS report later"),
 * and this is that component.
 *
 * `senderType` drives the styling per CONTRIBUTING.md's design rules —
 * customer messages are neutral filled, agent messages are the filled human
 * treatment.
 */
export function createMessageBubble(senderType: "customer" | "agent", body: string, createdAt: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${senderType}`;

  const text = document.createElement("p");
  text.className = "msg__body";
  text.textContent = body;

  const time = document.createElement("time");
  time.className = "msg__time";
  time.dateTime = createdAt;
  time.textContent = formatTime(createdAt);

  wrap.append(text, time);
  return wrap;
}

/**
 * A short local time for one message.
 *
 * Falls back to an empty string on an unparseable value rather than
 * rendering "Invalid Date" — a malformed timestamp is not worth showing a
 * visitor, and the message body is the part that matters.
 */
function formatTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
