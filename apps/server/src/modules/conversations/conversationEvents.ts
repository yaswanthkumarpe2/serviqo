import { EventEmitter } from "node:events";

import { logger } from "../../lib/logger";
import { toConversationStateResponse } from "../agentInbox/agentInbox.responses";

import type { ConversationDocument } from "./conversation.model";

/**
 * The conversation domain's event seam (ADR-026 §9) — the second instance of
 * the pattern ADR-025 §2 established for messages, and deliberately a second
 * INSTANCE rather than a generalization of it.
 *
 * `conversationService` publishes here after a claim, release, close, or
 * reopen is durably persisted; `realtime/createSocketServer.ts` subscribes and
 * performs the broadcast. No service imports `socket.io`, and no transport
 * re-derives who should hear about a state change.
 *
 * A shared `domainEvents` bus with a string topic is the natural refactor and
 * is declined here for the reason ADR-023 §12 declined to design the message
 * seam before its second consumer existed: two instances is where a pattern
 * becomes visible, not where it becomes a framework. The third consumer will
 * be able to see what actually varies between these two files; today the
 * honest answer is "the payload and the audience", which is most of them.
 *
 * Lives in `modules/conversations/` rather than `realtime/` because "a
 * conversation's state changed" is a fact about the domain, true whether or
 * not a socket server exists in this process. `realtime/` owns the
 * SUBSCRIBER, which is the transport concern.
 */

/**
 * What a subscriber receives.
 *
 * Deliberately NOT a `ConversationDocument`: a subscriber must not be able to
 * write through an event payload.
 *
 * `conversation` is `toConversationStateResponse`'s narrow projection, which
 * carries no customer and no assignee NAME — a broadcast has no single
 * reader, so there is no role to run `can(role, "member.read")` against, and
 * a payload that cannot make that check must not carry what the check
 * protects (ADR-026 §11).
 *
 * `organizationId` is lifted out so the subscriber never has to parse a room
 * key back out of the projection. No request-scoped logger travels with the
 * event either — a subscriber runs outside the request that caused it and
 * logs as itself.
 */
export interface ConversationUpdatedEvent {
  organizationId: string;
  conversationId: string;
  conversation: ReturnType<typeof toConversationStateResponse>;
}

export type ConversationUpdatedListener = (event: ConversationUpdatedEvent) => void;

const CONVERSATION_UPDATED = "conversation.updated";

/**
 * Node's `EventEmitter` dispatches synchronously, which is why `publish`
 * below guards every listener: without it, one throwing subscriber would
 * propagate into the awaiting caller and turn a successfully persisted state
 * change into a 500.
 *
 * `subscribe` returns its own unsubscribe rather than expecting callers to
 * reconstruct the function reference, for the reason `messageEvents` states:
 * a module-scope emitter with per-instance subscribers is safe only if the
 * subscribers are actually removed, and tests construct and tear down several
 * socket servers in one process.
 */
const emitter = new EventEmitter();

export const conversationEvents = {
  /** Registers a listener and returns the function that removes it (ADR-026 §9). */
  subscribe(listener: ConversationUpdatedListener): () => void {
    emitter.on(CONVERSATION_UPDATED, listener);
    return () => {
      emitter.off(CONVERSATION_UPDATED, listener);
    };
  },

  /**
   * Announces a persisted state change. Best-effort and never throws
   * (ADR-026 §9), matching `messageEvents.publish` exactly — the change is
   * durably stored before this runs, so nothing here may fail the write that
   * produced it.
   *
   * A subscriber's error is logged as an event name and an error class, never
   * as the payload that caused it.
   */
  publish(event: ConversationUpdatedEvent): void {
    try {
      emitter.emit(CONVERSATION_UPDATED, event);
    } catch (err) {
      logger.error(
        {
          event: "conversation.broadcast_failed",
          organizationId: event.organizationId,
          conversationId: event.conversationId,
          err: err instanceof Error ? err.name : "UnknownError",
        },
        "A conversation.updated subscriber threw",
      );
    }
  },

  /** Listener count, for tests that assert a socket server cleaned up after itself. */
  listenerCount(): number {
    return emitter.listenerCount(CONVERSATION_UPDATED);
  },
};

/**
 * Builds the event for a persisted conversation. One function, so the four
 * callers in `conversationService` — claim, release, close, and reopen —
 * cannot assemble four differently-shaped events for what is one fact.
 */
export function toConversationUpdatedEvent(
  organizationId: string,
  conversation: ConversationDocument,
): ConversationUpdatedEvent {
  return {
    organizationId,
    conversationId: conversation._id.toString(),
    conversation: toConversationStateResponse(conversation),
  };
}
