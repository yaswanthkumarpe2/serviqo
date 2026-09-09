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

/**
 * How a conversation's assignment reads to THIS agent (ADR-026 §11, §13).
 *
 * "Another agent" is the honest rendering when the server withheld the name,
 * which it does for any reader whose role lacks `member.read` — the `agent`
 * role among them. The component never invents a name and never shows a bare
 * user id, which would be both useless and a disclosure of an internal
 * identifier.
 */
function assignmentLabel(conversation: InboxConversation, currentUserId: string | null): string {
  const assignee = assigneeOf(conversation);
  if (assignee === null) return "Unassigned";
  if (assignee.id === currentUserId) return "Assigned to you";
  return `Assigned to ${assignee.name ?? "another agent"}`;
}

/**
 * A conversation's assignee, treating an ABSENT field as unassigned.
 *
 * `unwrapEnvelope` proves the envelope's shape and nothing about what is
 * inside it, so a row that arrives without `assignedTo` reaches this
 * component — and reading `.id` off `undefined` would throw during render and
 * take the whole dashboard down. The same posture `toPage` already takes for
 * a missing list: check at the boundary, render a legible state, never crash.
 */
function assigneeOf(conversation: InboxConversation) {
  return conversation.assignedTo ?? null;
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
                      {/*
                        The row states both facts a queue is read for: who has
                        it, and whether it is still live. Text rather than a
                        colour alone, so it survives a screen reader and a
                        monochrome display.
                      */}
                      <span className="inbox__rowMeta">
                        {assignmentLabel(conversation, inbox.currentUserId)}
                        {conversation.status === "closed" && <span className="inbox__closedTag"> · Closed</span>}
                      </span>
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

            {/*
              The end of the list is not the end of the history. The first page
              is the tenant's most recently active conversations (ADR-025 §5);
              without this control every conversation older than that page is
              in the database and unreachable from the dashboard.

              Rendered only when the server said there is more — an always-on
              button that sometimes returns nothing would make "no older
              conversations" indistinguishable from "the request failed".
            */}
            {inbox.hasOlderConversations && (
              <div className="inbox__more">
                <button
                  type="button"
                  className="inbox__moreButton"
                  onClick={() => void inbox.loadOlderConversations()}
                  disabled={inbox.isLoadingOlderConversations}
                >
                  {inbox.isLoadingOlderConversations ? "Loading…" : "Load older conversations"}
                </button>
              </div>
            )}

            {/*
              Beside the button rather than replacing the list: a failure here
              costs the page that did not arrive, never the ones already read.
            */}
            {inbox.olderConversationsError !== null && (
              <p className="inbox__state inbox__state--error" role="alert">
                {inbox.olderConversationsError}
              </p>
            )}
          </nav>

          <div className="inbox__thread">
            {selected === null ? (
              <p className="inbox__state" role="status">
                Select a conversation to read it.
              </p>
            ) : (
              <>
                <h3 className="inbox__threadTitle">{conversationTitle(selected)}</h3>

                {/*
                  Ownership and lifecycle (ADR-026 §13). Each control has its
                  own pending state, so a slow claim does not disable the
                  close button beside it.

                  There is deliberately NO control for a conversation another
                  agent holds: taking one is refused server-side for every
                  role (ADR-026 §4), and a button that always fails is worse
                  than an absent one.
                */}
                <div className="inbox__assignment">
                  <span className="inbox__assignee">{assignmentLabel(selected, inbox.currentUserId)}</span>

                  <div className="inbox__actions">
                    {assigneeOf(selected) === null && (
                      <button
                        type="button"
                        className="inbox__action"
                        onClick={() => void inbox.claim()}
                        disabled={inbox.pendingAction !== null}
                      >
                        {inbox.pendingAction === "claim" ? "Claiming…" : "Claim"}
                      </button>
                    )}

                    {assigneeOf(selected)?.id === inbox.currentUserId && inbox.currentUserId !== null && (
                      <button
                        type="button"
                        className="inbox__action"
                        onClick={() => void inbox.release()}
                        disabled={inbox.pendingAction !== null}
                      >
                        {inbox.pendingAction === "release" ? "Releasing…" : "Release"}
                      </button>
                    )}

                    {selected.status === "closed" ? (
                      <button
                        type="button"
                        className="inbox__action"
                        onClick={() => void inbox.setConversationStatus("open")}
                        disabled={inbox.pendingAction !== null}
                      >
                        {inbox.pendingAction === "reopen" ? "Reopening…" : "Reopen"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="inbox__action"
                        onClick={() => void inbox.setConversationStatus("closed")}
                        disabled={inbox.pendingAction !== null}
                      >
                        {inbox.pendingAction === "close" ? "Closing…" : "Close"}
                      </button>
                    )}
                  </div>
                </div>

                {inbox.actionError !== null && (
                  /*
                    The one place this UI states a reason (ADR-026 §13). Two of
                    the messages behind it — "another agent has this" and "this
                    customer already has a newer open conversation" — are the
                    refusals an agent can act on, and they are this client's
                    own words, never the server's text.
                  */
                  <p className="inbox__state inbox__state--error" role="alert">
                    {inbox.actionError}
                  </p>
                )}

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

                    {/*
                      A thread loads whole, so this is reached only past
                      `MAX_THREAD_PAGES` — ten thousand messages. It says
                      "newer", not "older", because messages page oldest-first:
                      what a truncated thread is missing is its most recent
                      end, and a button offering "older" would send an agent
                      the wrong way.
                    */}
                    {inbox.hasMoreMessages && (
                      <div className="inbox__more">
                        <button
                          type="button"
                          className="inbox__moreButton"
                          onClick={() => void inbox.loadMoreMessages()}
                          disabled={inbox.isLoadingMoreMessages}
                        >
                          {inbox.isLoadingMoreMessages ? "Loading…" : "Load newer messages"}
                        </button>
                      </div>
                    )}

                    {selected.status === "closed" ? (
                      /*
                        No composer on a closed conversation (ADR-026 §6, §13):
                        the server refuses the send, so offering the box would
                        be inviting a message that cannot be delivered. The
                        history above stays fully readable — closing ends the
                        exchange, not the record.
                      */
                      <p className="inbox__state" role="status">
                        This conversation is closed. Reopen it to reply.
                      </p>
                    ) : (
                      <>
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
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
