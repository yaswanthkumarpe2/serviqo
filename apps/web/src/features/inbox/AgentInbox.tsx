import { useState } from "react";

import { useAgentInbox } from "./useAgentInbox";

import type { InboxConversation, InboxMessage } from "./inboxApi";
import type { InboxSocketFactory } from "./inboxRealtime";

import "./AgentInbox.css";

/**
 * The agent inbox (ADR-025 §11): a conversation list, a message thread, and a
 * composer.
 *
 * Presentation only — every fetch, socket subscription, and de-duplication
 * rule lives in `useAgentInbox` (CONTRIBUTING.md: "No business logic in
 * JSX").
 *
 * MUST be mounted with `key={organizationId}` so switching tenants remounts
 * it rather than reconciling one tenant's conversations, unread counts, and
 * open socket into a component that just finished rendering another's. That
 * is what makes the isolation structural rather than a filter (ADR-025 §11).
 *
 * Visual language follows CONTRIBUTING.md's design rules: the agent's own
 * messages are the filled treatment, the customer's are neutral filled, and
 * no colour is hardcoded — every value is a token from `tokens.css`.
 */

export interface AgentInboxProps {
  organizationId: string;
  /** Injected by tests so the socket layer runs against a fake. */
  socketFactory?: InboxSocketFactory;
}

/** A conversation's display name — the customer's, or an honest stand-in. */
function conversationTitle(conversation: InboxConversation): string {
  const customer = conversation.customer;
  if (customer === null) return "Unknown customer";
  return customer.name ?? customer.email ?? "Anonymous visitor";
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function MessageBubble({ message }: { message: InboxMessage }) {
  const isAgent = message.senderType === "agent";

  return (
    <li className={`inbox__message inbox__message--${isAgent ? "agent" : "customer"}`}>
      <p className="inbox__messageBody">{message.body}</p>
      <p className="inbox__messageMeta">
        {/*
          Named rather than colour-coded alone: "filled is human" is a visual
          convention, and a screen reader gets nothing from it.
        */}
        <span className="inbox__messageSender">{isAgent ? "You" : "Customer"}</span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </p>
    </li>
  );
}

export function AgentInbox({ organizationId, socketFactory }: AgentInboxProps) {
  const inbox = useAgentInbox({ organizationId, socketFactory });
  const [draft, setDraft] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const body = draft;
    // Cleared optimistically so a fast second message is not typed into stale
    // text; a failure surfaces as `sendError` beneath the composer, and the
    // agent still has what they wrote in the thread's failure message.
    setDraft("");
    await inbox.send(body);
  }

  const selected = inbox.conversations.find((c) => c.id === inbox.selectedConversationId) ?? null;

  return (
    <section className="inbox card" aria-labelledby="inbox-heading">
      <div className="inbox__head">
        <h2 className="h3" id="inbox-heading">
          Inbox
        </h2>
        {/*
          The transport state, announced politely rather than as an alert:
          it changes on every network blip and must not interrupt an agent
          mid-reply. Nothing is shown while connected — a permanent "online"
          badge is noise.
        */}
        {inbox.realtimeStatus !== "connected" && (
          <span className="inbox__realtime" role="status">
            {inbox.realtimeStatus === "connecting"
              ? "Connecting…"
              : inbox.realtimeStatus === "reconnecting"
                ? "Reconnecting…"
                : "Live updates unavailable"}
          </span>
        )}
      </div>

      {inbox.status === "loading" && (
        <p className="inbox__state" role="status">
          Loading conversations…
        </p>
      )}

      {inbox.status === "forbidden" && (
        /*
          Its own state, not an error (ADR-025 §11): a role without
          `conversation.read` receives the same answer forever, so offering
          "try again" would be a lie.
        */
        <p className="inbox__state inbox__state--forbidden" role="status">
          Your role does not have access to conversations.
        </p>
      )}

      {inbox.status === "error" && (
        <p className="inbox__state inbox__state--error" role="alert">
          {inbox.error}
        </p>
      )}

      {inbox.status === "ready" && inbox.conversations.length === 0 && (
        <p className="inbox__state" role="status">
          No conversations yet. They appear here as soon as a visitor writes in.
        </p>
      )}

      {inbox.status === "ready" && inbox.conversations.length > 0 && (
        <div className="inbox__body">
          <nav className="inbox__list" aria-label="Conversations">
            <ul>
              {inbox.conversations.map((conversation) => {
                const unread = inbox.unreadCounts[conversation.id] ?? 0;
                const isSelected = conversation.id === inbox.selectedConversationId;

                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={`inbox__row${isSelected ? " inbox__row--selected" : ""}`}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => inbox.selectConversation(conversation.id)}
                    >
                      <span className="inbox__rowName">{conversationTitle(conversation)}</span>
                      <span className="inbox__rowTime">{formatTime(conversation.lastMessageAt)}</span>
                      {unread > 0 && (
                        /*
                          Session-local, and the UI never claims otherwise
                          (ADR-025 §12). The count is announced rather than
                          shown as a bare number, so it means something without
                          the colour.
                        */
                        <span className="inbox__unread" aria-label={`${unread} new messages`}>
                          {unread}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="inbox__thread">
            {selected === null ? (
              <p className="inbox__state" role="status">
                Select a conversation to read it.
              </p>
            ) : (
              <>
                <h3 className="inbox__threadTitle">{conversationTitle(selected)}</h3>

                {inbox.threadStatus === "loading" && (
                  <p className="inbox__state" role="status">
                    Loading messages…
                  </p>
                )}

                {inbox.threadStatus === "error" && (
                  <p className="inbox__state inbox__state--error" role="alert">
                    {inbox.threadError}
                  </p>
                )}

                {inbox.threadStatus === "ready" && (
                  <>
                    {inbox.messages.length === 0 ? (
                      <p className="inbox__state" role="status">
                        No messages in this conversation yet.
                      </p>
                    ) : (
                      <ul className="inbox__messages">
                        {inbox.messages.map((message) => (
                          <MessageBubble key={message.id} message={message} />
                        ))}
                      </ul>
                    )}

                    <form className="inbox__composer" onSubmit={handleSubmit}>
                      <label className="inbox__srOnly" htmlFor="inbox-composer">
                        Reply to this conversation
                      </label>
                      <textarea
                        id="inbox-composer"
                        className="inbox__input"
                        value={draft}
                        rows={2}
                        placeholder="Write a reply…"
                        onChange={(event) => setDraft(event.target.value)}
                        disabled={inbox.isSending}
                      />
                      <button
                        type="submit"
                        className="inbox__send"
                        disabled={inbox.isSending || draft.trim().length === 0}
                      >
                        {inbox.isSending ? "Sending…" : "Send"}
                      </button>
                    </form>

                    {inbox.sendError !== null && (
                      <p className="inbox__state inbox__state--error" role="alert">
                        {inbox.sendError}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
