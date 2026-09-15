import { useEffect, useState } from "react";

import { BellIcon, BellOffIcon, KeyboardIcon, NoteIcon, VolumeIcon, VolumeOffIcon } from "@/features/workspace/workspaceIcons";

import { ConversationTags } from "./ConversationTags";
import { COMPOSER_INPUT_ID, InboxComposer } from "./InboxComposer";
import { INBOX_SEARCH_INPUT_ID, InboxFilters } from "./InboxFilters";
import { ShortcutsHelp } from "./InboxShortcuts";
import { useInboxShortcuts } from "./useInboxShortcuts";
import { AttachmentView, LinkifiedText } from "./richText";
import { useAgentInbox } from "./useAgentInbox";

import type { ComposerMode } from "./InboxComposer";
import type { InboxConversation, InboxMessage, InboxNote } from "./inboxApi";
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
  /**
   * A conversation to open as soon as the list has loaded (ADR-033 §7).
   *
   * Set when the reader clicked a row on the workspace overview, which lives
   * in a sibling view: the click happens before this component exists, so the
   * intent has to arrive as a prop rather than as a call.
   *
   * Honoured ONCE, and only if the conversation is actually in the loaded
   * list — a stale id from a thread that has since been archived must not
   * select nothing and leave the pane blank.
   */
  initialConversationId?: string | null;
  /**
   * Called after `initialConversationId` has been acted on, so the owner can
   * clear it. Without this the same thread would reopen every time the reader
   * returned to this view.
   */
  onInitialConversationHandled?: () => void;
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

function MessageBubble({ message, seen }: { message: InboxMessage; seen: boolean }) {
  const isAgent = message.senderType === "agent";

  return (
    <li className={`inbox__message inbox__message--${isAgent ? "agent" : "customer"}`}>
      {(message.attachments ?? []).length > 0 && (
        <div className="inbox__attachments">
          {(message.attachments ?? []).map((attachment) => (
            <AttachmentView key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
      {message.body.length > 0 && (
        <p className="inbox__messageBody">
          <LinkifiedText text={message.body} />
        </p>
      )}
      <p className="inbox__messageMeta">
        {/*
          Named rather than colour-coded alone: "filled is human" is a visual
          convention, and a screen reader gets nothing from it.
        */}
        <span className="inbox__messageSender">{isAgent ? "Support" : "Customer"}</span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        {/* The customer has read up to here (ADR-040 §4). */}
        {seen && <span className="inbox__seen">Seen</span>}
      </p>
    </li>
  );
}

/** An internal note in the thread: yellow, labelled, and never mistaken for a message (ADR-042 §2). */
function NoteBubble({ note }: { note: InboxNote }) {
  return (
    <li className="inbox__message inbox__message--note">
      <p className="inbox__noteLabel">
        <NoteIcon aria-hidden="true" />
        Internal note · {note.author.name ?? "A teammate"}
      </p>
      <p className="inbox__messageBody">
        <LinkifiedText text={note.body} />
      </p>
      <p className="inbox__messageMeta">
        <time dateTime={note.createdAt}>{formatTime(note.createdAt)}</time>
      </p>
    </li>
  );
}

type TimelineEntry = { kind: "message"; item: InboxMessage } | { kind: "note"; item: InboxNote };

/** Messages and notes in one time-ordered thread. Stable: equal times keep messages first. */
function timelineOf(messages: InboxMessage[], notes: InboxNote[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map((item) => ({ kind: "message" as const, item })),
    ...notes.map((item) => ({ kind: "note" as const, item })),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.item.createdAt.localeCompare(b.entry.item.createdAt) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** The index of the last agent message the customer has read, or -1 (ADR-040 §4). */
function lastSeenAgentIndex(messages: InboxMessage[], customerLastReadAt: string | null | undefined): number {
  if (customerLastReadAt === null || customerLastReadAt === undefined) return -1;
  const readAt = new Date(customerLastReadAt).getTime();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.senderType !== "agent") continue;
    return new Date(message.createdAt).getTime() <= readAt ? index : -1;
  }
  return -1;
}

export function AgentInbox({
  organizationId,
  socketFactory,
  initialConversationId = null,
  onInitialConversationHandled,
}: AgentInboxProps) {
  /*
    The initial selection is handed to the HOOK rather than applied here in an
    effect. The hook opens it inside its own load callback, once the list it
    must be found in has arrived — which is the only place the write is not a
    synchronous setState inside an effect body (ADR-033 §7).
  */
  const inbox = useAgentInbox({ organizationId, socketFactory, initialConversationId });
  const [composerMode, setComposerMode] = useState<ComposerMode>("reply");
  const [showShortcuts, setShowShortcuts] = useState(false);

  const focusComposer = (mode: ComposerMode) => {
    setComposerMode(mode);
    requestAnimationFrame(() => document.getElementById(COMPOSER_INPUT_ID)?.focus());
  };

  useInboxShortcuts({
    next: () => inbox.selectAdjacentConversation(1),
    previous: () => inbox.selectAdjacentConversation(-1),
    search: () => document.getElementById(INBOX_SEARCH_INPUT_ID)?.focus(),
    reply: () => focusComposer("reply"),
    note: () => focusComposer("note"),
    toggleHelp: () => setShowShortcuts((open) => !open),
    closeHelp: () => setShowShortcuts(false),
  });

  const hasFilters = Object.keys(inbox.filters).length > 0;

  /*
    Told once, immediately: the hook has taken the id and will act on it when
    the list lands, so the owner can stop asking. Calling this during render
    would be a parent update from a child's render, so it rides the mount
    effect — which writes no state of this component's own.
  */
  useEffect(() => {
    if (initialConversationId !== null) onInitialConversationHandled?.();
    // Mount only: a later id arrives with a remount, because the workspace
    // keys this component by organization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = inbox.conversations.find((c) => c.id === inbox.selectedConversationId) ?? null;
  const seenIndex = selected === null ? -1 : lastSeenAgentIndex(inbox.messages, selected.customerLastReadAt);

  /* The total unread count in the tab title, so it is visible from another tab (ADR-040 §5). */
  const totalUnread = Object.values(inbox.unreadCounts).reduce((sum, count) => sum + count, 0);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\) /, "");
    document.title = totalUnread > 0 ? `(${totalUnread > 99 ? "99+" : totalUnread}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\+?\) /, "");
    };
  }, [totalUnread]);

  return (
    <section className="inbox card" aria-labelledby="inbox-heading">
      <div className="inbox__head">
        <h2 className="h3" id="inbox-heading">
          Inbox
        </h2>
        <div className="inbox__alerts">
          <button
            type="button"
            className="inbox__alertToggle"
            onClick={() => setShowShortcuts((open) => !open)}
            aria-expanded={showShortcuts}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <KeyboardIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            className="inbox__alertToggle"
            onClick={inbox.notifications.toggleSound}
            aria-pressed={inbox.notifications.soundEnabled}
            aria-label={inbox.notifications.soundEnabled ? "Mute new-message sound" : "Turn on new-message sound"}
            title={inbox.notifications.soundEnabled ? "Sound on" : "Sound off"}
          >
            {inbox.notifications.soundEnabled ? <VolumeIcon aria-hidden="true" /> : <VolumeOffIcon aria-hidden="true" />}
          </button>
          {inbox.notifications.desktopPermission !== "unsupported" && (
            <button
              type="button"
              className="inbox__alertToggle"
              onClick={() => void inbox.notifications.toggleDesktop()}
              aria-pressed={inbox.notifications.desktopEnabled}
              disabled={inbox.notifications.desktopPermission === "denied"}
              aria-label={
                inbox.notifications.desktopEnabled ? "Turn off desktop notifications" : "Turn on desktop notifications"
              }
              title={
                inbox.notifications.desktopPermission === "denied"
                  ? "Notifications are blocked in this browser"
                  : inbox.notifications.desktopEnabled
                    ? "Desktop notifications on"
                    : "Desktop notifications off"
              }
            >
              {inbox.notifications.desktopEnabled ? <BellIcon aria-hidden="true" /> : <BellOffIcon aria-hidden="true" />}
            </button>
          )}
        </div>
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

      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}

      {inbox.status === "ready" && inbox.conversations.length === 0 && !hasFilters && (
        <p className="inbox__state" role="status">
          No conversations yet. They appear here as soon as a visitor writes in.
        </p>
      )}

      {inbox.status === "ready" && (inbox.conversations.length > 0 || hasFilters) && (
        <div className="inbox__body">
          <nav className="inbox__list" aria-label="Conversations">
            <InboxFilters
              filters={inbox.filters}
              onChange={inbox.setFilters}
              tags={inbox.organizationTags}
              isFiltering={inbox.isFiltering}
            />
            {inbox.conversations.length === 0 && (
              <p className="inbox__state" role="status">
                No conversations match these filters.
              </p>
            )}
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
                        {inbox.customerTyping[conversation.id] ? (
                          <span className="inbox__typingTag">typing…</span>
                        ) : (
                          <>
                            {assignmentLabel(conversation, inbox.currentUserId)}
                            {conversation.status === "closed" && <span className="inbox__closedTag"> · Closed</span>}
                            {(conversation.tags ?? []).slice(0, 2).map((tag) => (
                              <span key={tag} className="inbox__rowTag">
                                {tag}
                              </span>
                            ))}
                          </>
                        )}
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
                {/* Contact details the visitor chose to give (ADR-038 §5). */}
                {(selected.customer?.email || selected.customer?.phone) && (
                  <p className="inbox__contact">
                    {[selected.customer?.email, selected.customer?.phone].filter(Boolean).join(" · ")}
                  </p>
                )}

                <ConversationTags
                  tags={selected.tags ?? []}
                  suggestions={inbox.organizationTags}
                  disabled={inbox.pendingAction !== null}
                  onChange={(tags) => void inbox.setTags(tags)}
                />

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
                    {inbox.messages.length === 0 && inbox.notes.length === 0 ? (
                      <p className="inbox__state" role="status">
                        No messages in this conversation yet.
                      </p>
                    ) : (
                      <ul className="inbox__messages">
                        {timelineOf(inbox.messages, inbox.notes).map((entry) =>
                          entry.kind === "note" ? (
                            <NoteBubble key={`note-${entry.item.id}`} note={entry.item} />
                          ) : (
                            <MessageBubble
                              key={entry.item.id}
                              message={entry.item}
                              seen={seenIndex >= 0 && inbox.messages[seenIndex]?.id === entry.item.id}
                            />
                          ),
                        )}
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
                        {inbox.customerTyping[selected.id] && (
                          <p className="inbox__typing" role="status">
                            <span className="inbox__typingDots" aria-hidden="true">
                              <i />
                              <i />
                              <i />
                            </span>
                            Customer is typing…
                          </p>
                        )}
                        {/* Two agents answering the same person at once is the collision this prevents (ADR-040 §3). */}
                        {inbox.colleagueTyping[selected.id] && (
                          <p className="inbox__typing inbox__typing--colleague" role="status">
                            A colleague is replying to this conversation.
                          </p>
                        )}
                        <InboxComposer
                          key={selected.id}
                          isSending={inbox.isSending}
                          send={inbox.send}
                          upload={inbox.upload}
                          onTyping={inbox.notifyTyping}
                          addNote={inbox.addNote}
                          savedReplies={inbox.savedReplies}
                          teammates={inbox.teammates}
                          currentUserId={inbox.currentUserId}
                          mode={composerMode}
                          onModeChange={setComposerMode}
                        />
                        {inbox.noteError !== null && (
                          <p className="inbox__state inbox__state--error" role="alert">
                            {inbox.noteError}
                          </p>
                        )}

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
