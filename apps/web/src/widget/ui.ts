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
