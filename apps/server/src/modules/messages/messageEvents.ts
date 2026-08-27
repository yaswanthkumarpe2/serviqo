import { EventEmitter } from "node:events";

import { logger } from "../../lib/logger";
import { toMessageResponse } from "../widget/widgetResponses";

import type { MessageDocument } from "./message.model";

/**
 * The message domain's event seam (ADR-025 §2) — the mechanism ADR-023 §12
 * deferred to this slice by name.
 *
 * `messageService` publishes here after a message is durably persisted;
 * `realtime/createSocketServer.ts` subscribes and performs every broadcast.
 * No service imports `socket.io`, and no transport re-derives who should
 * receive a message.
 *
 * This lives in `modules/messages/` rather than `realtime/` because "a
 * message was created" is a fact about the domain, true whether or not a
 * socket server exists in this process. `realtime/` owns the SUBSCRIBER,
 * which is the transport concern.
 */

/**
 * What a subscriber receives.
 *
 * Deliberately NOT a `MessageDocument`: a subscriber must not be able to
 * write through an event payload. `message` is the same projection every
 * transport already sends (ADR-022 §13, ADR-023 §7), and the two routing
 * ids are lifted out so a subscriber never has to parse them back out of it.
 *
 * No request-scoped logger travels with the event either — a subscriber runs
 * outside the request that caused it and logs as itself.
 */
export interface MessageCreatedEvent {
  organizationId: string;
  conversationId: string;
  message: ReturnType<typeof toMessageResponse>;
}

export type MessageCreatedListener = (event: MessageCreatedEvent) => void;

const MESSAGE_CREATED = "message.created";

/**
 * Node's `EventEmitter` dispatches synchronously, which is why `publish`
 * below guards every listener: without it, one throwing subscriber would
 * propagate into the awaiting caller and turn a successfully persisted
 * message into a 500.
 *
 * The default max-listener warning is irrelevant here — one subscriber per
 * socket server, and there is one socket server — but a leaked subscriber is
 * a real hazard, which is why `subscribe` returns its own unsubscribe rather
 * than expecting callers to reconstruct the function reference.
 */
const emitter = new EventEmitter();

export const messageEvents = {
  /**
   * Registers a listener and returns the function that removes it.
   *
   * The returned unsubscribe is the ONLY supported removal path (ADR-025 §2):
   * a module-scope emitter with per-instance subscribers is safe only if the
   * subscribers are actually removed, and tests construct and tear down
   * several socket servers in one process.
   */
  subscribe(listener: MessageCreatedListener): () => void {
    emitter.on(MESSAGE_CREATED, listener);
    return () => {
      emitter.off(MESSAGE_CREATED, listener);
    };
  },

  /**
   * Announces a persisted message. Best-effort and never throws
   * (ADR-025 §2), matching exactly how `messageService` already treats
   * `touchLastMessageAt` (ADR-022 §10) — the message is durably stored
   * before this runs, so nothing here may fail the write that produced it.
   *
   * A subscriber's error is logged as an event name and a class, never as
   * the payload that caused it: this function holds a message body, and a
   * body is customer content that does not belong in a log (ADR-022 §14).
   */
  publish(event: MessageCreatedEvent): void {
    try {
      emitter.emit(MESSAGE_CREATED, event);
    } catch (err) {
      logger.error(
        {
          event: "message.broadcast_failed",
          organizationId: event.organizationId,
          conversationId: event.conversationId,
          messageId: event.message.id,
          err: err instanceof Error ? err.name : "UnknownError",
        },
        "A message.created subscriber threw",
      );
    }
  },

  /** Listener count, for tests that assert a socket server cleaned up after itself. */
  listenerCount(): number {
    return emitter.listenerCount(MESSAGE_CREATED);
  },
};

/**
 * Builds the event for a persisted message. One function, so the two callers
 * in `messageService` cannot assemble differently-shaped events for what is
 * the same fact.
 */
export function toMessageCreatedEvent(organizationId: string, message: MessageDocument): MessageCreatedEvent {
  return {
    organizationId,
    conversationId: message.conversationId.toString(),
    message: toMessageResponse(message),
  };
}
