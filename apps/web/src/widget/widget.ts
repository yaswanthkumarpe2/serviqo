import { darken, isWithinBusinessHours } from "./availability";
import { WidgetAuthError, loadHistory, resolveConversation } from "./conversation";
import { RealtimeError, createRealtimeClient } from "./realtime";
import { openWidgetSession, WidgetSessionError } from "./session";
import { clearStoredToken, loadStoredToken, loadVisitorKey, storeToken, storeVisitorKey } from "./storage";
import { WIDGET_STYLES } from "./styles";
import { createChatSurface, createLauncher, createMessageBubble, createPanelSkeleton } from "./ui";

import type { RealtimeClient, RealtimeStatus, SocketFactory } from "./realtime";
import type { ChatSurface } from "./ui";
import type { WidgetAppearance, WidgetConfig, WidgetMessage, WidgetSessionCustomer } from "./types";

/**
 * Mounts the widget and wires its interactions (ADR-021 §3, §7, §8, §9;
 * ADR-024 §3–§7).
 *
 * Structured as a function that returns a `{ destroy }` handle rather than a
 * top-level side effect, so it is directly unit-testable under `jsdom`
 * without loading the bundled entry point, and so a caller can tear one
 * mount down cleanly (ADR-021 §9) — which now includes closing a socket.
 */

export interface WidgetHandle {
  destroy(): void;
}

/**
 * Mirrors `MESSAGE_BODY_MAX_LENGTH` (ADR-022 §9). Restated rather than
 * imported: the widget bundle shares no code with the server (ADR-021 §2),
 * and this is a courtesy bound on the composer, never a validation boundary
 * (ADR-024 §11) — the server enforces the real one at two layers and still
 * rejects an over-length body.
 */
const MESSAGE_BODY_MAX_LENGTH = 4000;

type PanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; customer: WidgetSessionCustomer; token: string; conversationId: string }
  | { status: "error"; message: string };

const GENERIC_ERROR_MESSAGE = "Chat is not available right now.";
const SEND_FAILED_MESSAGE = "Message not sent. Please try again.";

/**
 * The ack code the server answers when an agent has closed this conversation
 * (ADR-026 §6).
 *
 * Restated here rather than imported across the server boundary, exactly as
 * `realtime.ts` restates the event names: the widget bundle shares no code
 * with the server (ADR-021 §2).
 */
const CONVERSATION_CLOSED_CODE = "CONVERSATION_CLOSED";

/** One sentence per transport state (ADR-024 §7). No status code, no server text. */
const STATUS_TEXT: Record<RealtimeStatus, string> = {
  connecting: "Connecting…",
  connected: "",
  reconnecting: "Reconnecting…",
  failed: "You're offline. Reopen the chat to try again.",
};

export interface InitWidgetOptions {
  /** Injected by tests so the socket layer runs against a fake (ADR-024 §2). */
  socketFactory?: SocketFactory;
  /**
   * How the chat is presented (ADR-038 §6).
   *
   * - `"launcher"` (default): the embed. A floating bubble on a page Serviqo
   *   does not own, opening a panel on demand.
   * - `"page"`: the organisation's hosted chat link, `/widget/<slug>`. The
   *   chat IS the page, so it is open from the start, has no bubble and no
   *   close button, and Escape does nothing — there is nowhere to close to.
   *
   * Everything behind the panel — session, visitor key, conversation,
   * history, socket, de-duplication, closed-conversation recovery — is the
   * same code in both. A second chat implementation for the hosted page would
   * be a second place for any of those to be subtly wrong.
   */
  presentation?: "launcher" | "page";
  /** Where to mount. Defaults to `document.body`; the hosted page passes its own container. */
  container?: HTMLElement;
  /** The panel title — the organisation's name on its hosted page. */
  title?: string;
}

/**
 * Mounts the widget into `document.body`, or returns `null` without
 * touching the DOM if Shadow DOM is unavailable (ADR-021 §3's graceful
 * absence: a missing widget beats unscoped CSS on a page Serviqo does not
 * own).
 */
export function initWidget(config: WidgetConfig, options: InitWidgetOptions = {}): WidgetHandle | null {
  if (typeof document.createElement("div").attachShadow !== "function") {
    console.warn("Serviqo widget: this browser does not support Shadow DOM; the widget was not mounted.");
    return null;
  }

  const isPage = options.presentation === "page";

  const host = document.createElement("div");
  host.setAttribute("data-serviqo-widget-host", "true");
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = WIDGET_STYLES;
  shadow.appendChild(styleEl);

  const root = document.createElement("div");
  root.className = isPage ? "root root--page" : "root";
  shadow.appendChild(root);

  const launcher = createLauncher();
  const panel = createPanelSkeleton("serviqo-widget-title", options.title);
  if (isPage) {
    /*
      Not a dialog on its own page: it is the page's main content, and
      `aria-modal` would tell a screen reader everything else is inert when
      there is nothing else.
    */
    panel.element.removeAttribute("role");
    panel.element.removeAttribute("aria-modal");
    panel.closeButton.hidden = true;
    root.append(panel.element);
  } else {
    root.append(panel.element, launcher);
  }

  let state: PanelState = { status: "idle" };
  let isOpen = false;

  // ---- chat state ----

  let chat: ChatSurface | null = null;
  let realtime: RealtimeClient | null = null;

  /**
   * Every message id ever rendered by this mount — the SINGLE de-duplication
   * mechanism (ADR-024 §4), checked at the one append point below.
   *
   * `Message._id` is server-assigned, immutable, and globally unique
   * (ADR-022 §11 relies on exactly those properties to use it as the sort key
   * and pagination cursor), which is what makes it the correct identity here
   * rather than the body text or an array position.
   *
   * Deliberately NOT cleared on reconnect or on close/open: its whole
   * purpose is to outlive those events, since they are precisely when the
   * same message can arrive a second time.
   */
  const seenMessageIds = new Set<string>();

  /** The last message id rendered, used as the catch-up cursor after a re-join (ADR-024 §5). */
  let lastRenderedMessageId: string | null = null;

  // ---- live chat state (ADR-040) ----

  /** The organisation's colour, title and messages, once the session has said. */
  let appearance: WidgetAppearance | null = null;
  /** Whether an agent of this organisation is connected. */
  let agentsOnline = false;
  /** When the team last read this conversation, for "Seen". */
  let agentReadAt: string | null = null;
  let isAgentTyping = false;
  let agentTypingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Agent messages that arrived while the launcher panel was closed. */
  let unseenWhileClosed = 0;
  /** When this visitor last told the server they are typing, and the timer that says they stopped. */
  let lastTypingSentAt = 0;
  let typingIdleTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: PanelState) {
    state = next;
    renderBody();
  }

  // ---- state → DOM ----

  function renderBody() {
    // The chat surface is rebuilt whenever the body is re-rendered, so the
    // handle must not outlive it.
    chat = null;
    panel.body.replaceChildren();

    if (state.status === "idle" || state.status === "loading") {
      panel.body.appendChild(renderLoading());
      return;
    }

    if (state.status === "error") {
      panel.body.appendChild(renderError(state.message));
      return;
    }

    panel.body.appendChild(renderChat());
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

  /**
   * Builds the chat surface and replays every message already rendered by
   * this mount.
   *
   * The replay reads `renderedMessages` rather than re-fetching, and it is
   * why the surface can be rebuilt (on close/open, or after a retry) without
   * a network call and without the id `Set` producing an empty list — the
   * `Set` suppresses *appends*, so replay writes DOM directly.
   */
  function renderChat(): HTMLElement {
    const surface = createChatSurface(MESSAGE_BODY_MAX_LENGTH);
    chat = surface;

    /*
      The optional details control ADR-021 §8 introduced, carried forward
      into the chat surface rather than dropped: it is still the only way a
      visitor volunteers a name or email, and submitting it still resolves
      as a RESUME of the same customer (ADR-019 §6), never a second one.
      Shown only while the server says it has neither value.
    */
    if (
      state.status === "ready" &&
      state.customer.name === null &&
      state.customer.email === null &&
      state.customer.phone === null
    ) {
      surface.element.insertBefore(renderDetailsForm(), surface.list);
    }

    for (const message of renderedMessages) {
      surface.list.appendChild(createMessageBubble(message.senderType, message.body, message.createdAt));
    }
    if (renderedMessages.length === 0) renderEmptyState(surface);

    // "Typing…" sits between the thread and the composer, so it never scrolls away (ADR-040 §3).
    surface.element.insertBefore(typingIndicator, surface.notice);
    typingIndicator.hidden = !isAgentTyping;
    surface.input.addEventListener("input", onComposerInput);

    applyStatus(surface, currentStatus);

    surface.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitMessage();
    });

    // Enter sends, Shift+Enter inserts a newline — the convention every chat
    // surface uses, and the reason the composer is a textarea rather than an
    // input (a multi-line body is valid, ADR-022 §9).
    surface.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submitMessage();
      }
    });

    updateSeenMarker(surface);

    return surface.element;
  }

  function renderEmptyState(surface: ChatSurface) {
    const empty = document.createElement("p");
    empty.className = "chat__empty";
    empty.textContent = "How can we help? Send us a message and we'll reply here.";
    surface.list.appendChild(empty);
  }

  /**
   * The optional "share your name and email" control (ADR-021 §8), unchanged
   * in behavior: it calls `POST /widget/session` again with the stored
   * `visitorToken` plus the supplied fields, which the server resolves as a
   * resume that UPDATES the same `Customer` (ADR-019 §6) rather than
   * creating a second one. Nothing here is required, and nothing reads a
   * supplied value back to find anyone (ADR-019 §5).
   */
  function renderDetailsForm(): HTMLElement {
    const details = document.createElement("details");
    details.className = "details details--chat";
    const summary = document.createElement("summary");
    summary.textContent = "Share your contact details (optional)";
    details.appendChild(summary);

    const form = document.createElement("form");
    form.noValidate = true;

    const nameField = createField("serviqo-widget-name", "Name", "text");
    const emailField = createField("serviqo-widget-email", "Email", "email");
    // Optional like the other two, and never required to chat (ADR-038 §5).
    const phoneField = createField("serviqo-widget-phone", "Phone", "tel");
    form.append(nameField.wrap, emailField.wrap, phoneField.wrap);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "submit";
    submit.textContent = "Save";
    form.appendChild(submit);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = nameField.input.value.trim();
      const email = emailField.input.value.trim();
      const phone = phoneField.input.value.trim();
      if (name.length === 0 && email.length === 0 && phone.length === 0) return;

      submit.disabled = true;
      void submitDetails({
        ...(name.length > 0 ? { name } : {}),
        ...(email.length > 0 ? { email } : {}),
        ...(phone.length > 0 ? { phone } : {}),
      }).finally(() => {
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
    input.autocomplete = type === "email" ? "email" : type === "tel" ? "tel" : "name";
    wrap.append(label, input);
    return { wrap, input };
  }

  /**
   * Submits the optional details as a session resume.
   *
   * The conversation, the socket, and every rendered message are untouched:
   * this updates the `Customer` record only. The panel re-renders so the
   * control disappears once the server confirms it has the values — and the
   * chat surface rebuilds from `renderedMessages`, which is why that replay
   * exists (see `renderChat`).
   */
  async function submitDetails(details: { name?: string; email?: string; phone?: string }) {
    if (state.status !== "ready") return;
    const { token, conversationId } = state;

    try {
      const result = await openWidgetSession(config.apiBase, {
        widgetKey: config.widgetKey,
        visitorToken: token,
        ...details,
      });
      rememberVisitor(result);
      setState({ status: "ready", customer: result.customer, token: result.token, conversationId });
    } catch {
      // The customer's existing session stays usable; only the detail
      // update failed. Nothing is logged, and the conversation is unaffected.
    }
  }

  /**
   * Every message rendered by this mount, in order — the source for
   * rebuilding the surface without a network call.
   */
  const renderedMessages: WidgetMessage[] = [];

  /**
   * THE single append point (ADR-024 §4).
   *
   * Every message from every source funnels through here — history, the
   * `message:new` broadcast, the send ack, and the post-reconnect catch-up —
   * so one id check covers all five duplication paths at once. A guard at
   * each call site instead would be five guards, and forgetting the sixth
   * is a visibly duplicated conversation.
   */
  function appendMessage(message: WidgetMessage): void {
    if (seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);
    renderedMessages.push(message);
    lastRenderedMessageId = message.id;

    if (chat === null) return;

    const empty = chat.list.querySelector(".chat__empty");
    if (empty !== null) empty.remove();

    chat.list.appendChild(createMessageBubble(message.senderType, message.body, message.createdAt));

    if (message.senderType === "agent") {
      // A reply arriving ends "typing", and is read at once if someone is looking.
      setAgentTyping(false);
      if (isOpen) markReadIfVisible();
      else {
        unseenWhileClosed += 1;
        renderLauncherBadge();
      }
    }

    updateSeenMarker(chat);
    scrollToLatest();
  }

  // ---- appearance, availability, typing and "seen" (ADR-040) ----

  const typingIndicator = document.createElement("div");
  typingIndicator.className = "chat__typing";
  typingIndicator.setAttribute("role", "status");
  typingIndicator.hidden = true;
  typingIndicator.innerHTML = '<span class="chat__typingDots" aria-hidden="true"><i></i><i></i><i></i></span>';
  const typingLabel = document.createElement("span");
  typingLabel.className = "sr-only";
  typingLabel.textContent = "Support is typing";
  typingIndicator.appendChild(typingLabel);

  const launcherBadge = document.createElement("span");
  launcherBadge.className = "launcher__badge";
  launcherBadge.hidden = true;
  launcher.appendChild(launcherBadge);

  function renderLauncherBadge() {
    launcherBadge.hidden = unseenWhileClosed === 0;
    launcherBadge.textContent = unseenWhileClosed > 9 ? "9+" : String(unseenWhileClosed);
    launcher.setAttribute("aria-label", unseenWhileClosed > 0 ? `Open chat, ${unseenWhileClosed} new` : "Open chat");
  }

  function applyAppearance() {
    const title = appearance?.title ?? options.title ?? "Chat with us";
    panel.title.textContent = title;
    if (appearance !== null) {
      root.style.setProperty("--sq-brand", appearance.accentColor);
      root.style.setProperty("--sq-brand-dark", darken(appearance.accentColor));
    }
    renderAvailability();
  }

  /** Online means an agent is connected AND it is within business hours. */
  function renderAvailability() {
    const online = agentsOnline && isWithinBusinessHours(appearance?.businessHours);
    panel.statusDot.classList.toggle("panel__dot--online", online);
    panel.subtitle.textContent = online
      ? (appearance?.welcomeMessage ?? "We usually reply within a few minutes.")
      : (appearance?.awayMessage ?? "We're away right now. Leave a message and we'll reply here.");
  }

  function setAgentTyping(next: boolean) {
    isAgentTyping = next;
    typingIndicator.hidden = !next;
    if (agentTypingTimer !== null) clearTimeout(agentTypingTimer);
    agentTypingTimer = null;
    // A "stopped typing" can be lost with a dropped connection; never show it forever.
    if (next) agentTypingTimer = setTimeout(() => setAgentTyping(false), 6000);
    if (next) scrollToLatest();
  }

  /**
   * "Seen" under this visitor's latest message, once the team has read past it.
   * One marker at most, and only for a message sent before the read.
   */
  function updateSeenMarker(surface: ChatSurface) {
    surface.list.querySelector(".msg__seen")?.remove();
    if (agentReadAt === null) return;

    const bubbles = surface.list.querySelectorAll<HTMLDivElement>(".msg");
    const last = bubbles[bubbles.length - 1];
    if (last === undefined || !last.classList.contains("msg--customer")) return;
    if (new Date(agentReadAt).getTime() < new Date(last.dataset.createdAt ?? "").getTime()) return;

    const seen = document.createElement("p");
    seen.className = "msg__seen";
    seen.textContent = "Seen";
    last.insertAdjacentElement("afterend", seen);
  }

  function markReadIfVisible() {
    if (state.status !== "ready" || realtime === null || !isOpen) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    realtime.markRead(state.conversationId);
  }

  /** Tells the team this visitor is typing: at most every 2.5s, and "stopped" after 3s idle. */
  function onComposerInput() {
    if (state.status !== "ready" || realtime === null) return;
    const now = Date.now();
    if (now - lastTypingSentAt > 2500) {
      realtime.typing(state.conversationId, true);
      lastTypingSentAt = now;
    }
    if (typingIdleTimer !== null) clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(stopTyping, 3000);
  }

  function stopTyping() {
    if (typingIdleTimer !== null) clearTimeout(typingIdleTimer);
    typingIdleTimer = null;
    if (lastTypingSentAt === 0) return;
    lastTypingSentAt = 0;
    if (state.status === "ready" && realtime !== null) realtime.typing(state.conversationId, false);
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") markReadIfVisible();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Business hours can open or close while the chat sits open.
  const availabilityTimer = setInterval(renderAvailability, 60_000);

  function scrollToLatest() {
    if (chat === null) return;
    // `scrollTop` is not implemented under jsdom, so this is best-effort by
    // construction rather than by a guard.
    chat.list.scrollTop = chat.list.scrollHeight;
  }

  // ---- transport status ----

  let currentStatus: RealtimeStatus = "connecting";

  function setStatus(next: RealtimeStatus) {
    currentStatus = next;
    if (chat !== null) applyStatus(chat, next);
  }

  /**
   * The message list stays visible in every state; only `failed` disables
   * the composer, because only then is there no path for a message to reach
   * the server (ADR-024 §7).
   */
  function applyStatus(surface: ChatSurface, status: RealtimeStatus) {
    const text = STATUS_TEXT[status];
    surface.status.textContent = text;
    surface.status.hidden = text.length === 0;
    surface.status.classList.toggle("chat__status--failed", status === "failed");

    const disabled = status === "failed";
    surface.input.disabled = disabled;
    surface.sendButton.disabled = disabled;
  }

  function showNotice(message: string) {
    if (chat === null) return;
    chat.notice.textContent = message;
    chat.notice.hidden = false;
  }

  function clearNotice() {
    if (chat === null) return;
    chat.notice.textContent = "";
    chat.notice.hidden = true;
  }

  // ---- network calls ----

  /**
   * The ordered open sequence (ADR-024 §3):
   *
   *   session → resolve conversation → history → socket connect + join
   *
   * History loads over REST BEFORE the socket connects, deliberately: the
   * inverse order can drop a message delivered between the fetch's snapshot
   * and the first listener being attached, while this order can only
   * duplicate one — and duplication is eliminated completely by §4 while a
   * dropped message could only be papered over.
   */
  /**
   * Stores what the server just issued: always a token, and a visitor key
   * only on the one response that minted it (ADR-038 §3).
   */
  function rememberVisitor(session: { token: string; visitorKey?: string }) {
    storeToken(config.widgetKey, session.token);
    if (session.visitorKey !== undefined) storeVisitorKey(config.widgetKey, session.visitorKey);
  }

  async function openSession() {
    setState({ status: "loading" });

    const visitorToken = loadStoredToken(config.widgetKey) ?? undefined;
    /*
      Offered alongside the token; the server tries the token first. The key
      is what finds this visitor's conversation again once the one-day token
      has expired — a customer never signs in, so without it every return
      visit after a day would start an empty thread (ADR-038 §3).
    */
    const visitorKey = loadVisitorKey(config.widgetKey) ?? undefined;

    try {
      const session = await openWidgetSession(config.apiBase, {
        widgetKey: config.widgetKey,
        ...(visitorToken !== undefined ? { visitorToken } : {}),
        ...(visitorKey !== undefined ? { visitorKey } : {}),
      });
      rememberVisitor(session);
      appearance = session.appearance ?? null;
      agentsOnline = session.availability?.agentsOnline ?? false;
      applyAppearance();

      const conversation = await resolveConversation(config.apiBase, session.token);
      agentReadAt = conversation.agentLastReadAt ?? null;
      const history = await loadHistory(config.apiBase, session.token, conversation.id);

      setState({
        status: "ready",
        customer: session.customer,
        token: session.token,
        conversationId: conversation.id,
      });

      for (const message of history) appendMessage(message);
      scrollToLatest();

      startRealtime(session.token, conversation.id);
      // History loaded before `isOpen` checks run for each message; count unread once, here.
      if (!isOpen && (conversation.unreadCount ?? 0) > 0) {
        unseenWhileClosed = conversation.unreadCount ?? 0;
        renderLauncherBadge();
      }
    } catch (error) {
      /*
        A token the server has refused is cleared (ADR-024 §8): keeping it
        would make every retry — and every reload for the rest of the tab's
        life — fail identically, with the widget re-presenting a credential
        it has already been told is no good.
      */
      if (error instanceof WidgetAuthError) clearStoredToken(config.widgetKey);

      const message = error instanceof WidgetSessionError ? error.message : GENERIC_ERROR_MESSAGE;
      setState({ status: "error", message });
    }
  }

  /**
   * Connects the socket and wires re-join + catch-up.
   *
   * `onConnected` fires from the library's `connect` handler on EVERY
   * connection, first and reconnect alike (ADR-023 §10, ADR-024 §5), so
   * there is no reconnect-only branch that could rot from never running in
   * development.
   */
  function startRealtime(token: string, conversationId: string) {
    realtime?.destroy();

    realtime = createRealtimeClient({
      socketOrigin: config.socketOrigin,
      token,
      ...(options.socketFactory !== undefined ? { factory: options.socketFactory } : {}),
      callbacks: {
        onMessage: appendMessage,
        onStatusChange: setStatus,
        onConnected: () => {
          /*
            Reads the CURRENT conversation rather than the one captured when
            this client was built. The two differ after a closed-conversation
            recovery (ADR-026 §8) — a reconnect that re-joined the captured id
            would put the socket back in the room of the thread the agent
            closed, and live delivery for the new one would silently stop.
          */
          void rejoinAndCatchUp(token, state.status === "ready" ? state.conversationId : conversationId);
        },
        onAuthFailure: () => {
          clearStoredToken(config.widgetKey);
        },
        onPresence: (online) => {
          agentsOnline = online;
          renderAvailability();
        },
        onAgentTyping: (typingConversationId, typing) => {
          if (state.status === "ready" && state.conversationId === typingConversationId) setAgentTyping(typing);
        },
        onAgentRead: (readConversationId, readAt) => {
          if (state.status !== "ready" || state.conversationId !== readConversationId) return;
          agentReadAt = readAt;
          if (chat !== null) updateSeenMarker(chat);
        },
      },
    });

    realtime.connect();
  }

  /**
   * Re-joins the conversation room, then fetches anything persisted while
   * this client was away (ADR-024 §5).
   *
   * The catch-up runs unconditionally: it either finds nothing, or finds
   * messages genuinely not seen, and anything it re-returns is dropped at
   * the append point. That is what makes it safe without tracking whether
   * this was a first connection or a reconnect.
   */
  async function rejoinAndCatchUp(token: string, conversationId: string) {
    if (realtime === null) return;

    try {
      await realtime.join(conversationId);
    } catch {
      // The join failed (refused, or the socket dropped mid-handshake). The
      // library keeps retrying the connection underneath and `onConnected`
      // will run again; nothing is logged (ADR-024 §9).
      return;
    }

    clearNotice();
    markReadIfVisible();

    try {
      const missed = await loadHistory(
        config.apiBase,
        token,
        conversationId,
        lastRenderedMessageId ?? undefined,
      );
      for (const message of missed) appendMessage(message);
    } catch {
      // A failed catch-up leaves the conversation exactly as it was; live
      // delivery still works, and the next reconnect tries again.
    }
  }

  /**
   * Sends the composer's contents (ADR-024 §6).
   *
   * No optimistic render and no client-generated id: the message is
   * rendered when it arrives as data from the server, via the ack or via
   * `message:new`, whichever lands first — both funnelled through
   * `appendMessage`, so the second is a no-op.
   *
   * A failure RESTORES the typed text rather than discarding it: a visitor
   * who typed a paragraph and lost their connection must not lose the
   * paragraph.
   */
  async function submitMessage() {
    if (chat === null || state.status !== "ready" || realtime === null) return;

    const body = chat.input.value.trim();
    if (body.length === 0) return;

    const surface = chat;
    const conversationId = state.conversationId;

    surface.input.value = "";
    surface.input.disabled = true;
    surface.sendButton.disabled = true;
    clearNotice();
    stopTyping();

    try {
      const message = await realtime.send(conversationId, body);
      appendMessage(message);
    } catch (error) {
      /*
        An agent closed this conversation while the panel was open
        (ADR-026 §6). Recovered rather than reported: `resolveConversation`
        returns a NEW open conversation precisely because the old one is
        closed, so the visitor's message lands in a fresh thread and the agent
        sees a new row — which is the truthful representation of what
        happened.

        The visitor is never told any of this. From their side nothing was
        closed: they typed a message and it was delivered (ADR-026 §8, §10).
      */
      const recovered = isClosedConversationError(error) ? await retryInNewConversation(body) : false;

      if (!recovered) {
        // No error detail reaches the visitor or the console (ADR-024 §7, §9).
        surface.input.value = body;
        showNotice(SEND_FAILED_MESSAGE);
      }
    } finally {
      if (currentStatus !== "failed") {
        surface.input.disabled = false;
        surface.sendButton.disabled = false;
      }
      surface.input.focus();
    }
  }

  /** Whether a send failed because the conversation has been closed (ADR-026 §6). */
  function isClosedConversationError(error: unknown): boolean {
    return error instanceof RealtimeError && error.code === CONVERSATION_CLOSED_CODE;
  }

  /**
   * Resolves a new open conversation and re-sends into it — ONCE
   * (ADR-026 §8).
   *
   * Returns whether the message was delivered, so the caller shows its
   * failure notice only when this did not work.
   *
   * Bounded to a single attempt deliberately: a conversation that keeps being
   * closed would otherwise be a loop, and every failure this does not recover
   * from already has a handler.
   *
   * The conversation id is swapped WITHOUT `setState`, which would rebuild the
   * chat surface mid-send and blank the thread under the visitor's cursor. The
   * messages already on screen stay — they are this visitor's own history, and
   * hiding them because an agent filed the thread differently would be the
   * widget reporting an internal workflow event as a loss of their
   * conversation.
   */
  async function retryInNewConversation(body: string): Promise<boolean> {
    if (state.status !== "ready" || realtime === null) return false;

    const { token, customer } = state;

    try {
      const conversation = await resolveConversation(config.apiBase, token);

      state = { status: "ready", customer, token, conversationId: conversation.id };

      // Joined before sending: the server refuses a send into a conversation
      // this socket has not joined (ADR-023 §5).
      await realtime.join(conversation.id);

      const message = await realtime.send(conversation.id, body);
      appendMessage(message);
      return true;
    } catch {
      // Nothing is logged and no detail reaches the visitor (ADR-024 §9). The
      // caller restores their typed text and shows the ordinary notice.
      return false;
    }
  }

  // ---- open / close ----

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && isOpen && !isPage) close();
  }

  function open() {
    isOpen = true;
    panel.element.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKeyDown);
    panel.closeButton.focus();

    unseenWhileClosed = 0;
    renderLauncherBadge();
    markReadIfVisible();

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
  (options.container ?? document.body).appendChild(host);

  /*
    The hosted page opens straight into the conversation. `open()` is not used:
    it moves focus to the close button, which this presentation hides, and
    listens for Escape, which has nothing to close.
  */
  if (isPage) {
    isOpen = true;
    panel.element.hidden = false;
    void openSession();
  }

  function destroy() {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    clearInterval(availabilityTimer);
    if (agentTypingTimer !== null) clearTimeout(agentTypingTimer);
    if (typingIdleTimer !== null) clearTimeout(typingIdleTimer);
    realtime?.destroy();
    realtime = null;
    host.remove();
  }

  return { destroy };
}
