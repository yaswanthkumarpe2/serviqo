import { EventEmitter } from "node:events";

import { logger } from "../../lib/logger";

/**
 * The membership domain's event seam (ADR-029 §9) — the THIRD instance of the
 * pattern ADR-025 §2 established for messages and ADR-026 §9 reused for
 * conversation state, and the first whose subscriber does not broadcast
 * anything.
 *
 * `memberService` publishes here after a member's staff access to a tenant has
 * been durably revoked — by suspension (ADR-029 §6) or by removal
 * (ADR-027 §10). `realtime/createSocketServer.ts` subscribes and CLOSES that
 * person's agent sockets in that tenant. No service imports `socket.io`, and
 * the transport still does not know what a membership is: the event states a
 * domain fact, and the subscriber decides that the fact means disconnecting
 * someone.
 *
 * WHY THIS EXISTS AT ALL. Both of Serviqo's membership gates run exactly once
 * — `requireOrganization` per request (ADR-017 §2) and `socketAuthentication`
 * per handshake (ADR-025 §9) — and the Socket.IO fan-out performs zero
 * membership lookups per event, by construction, because re-proving membership
 * per broadcast would put a database round-trip on every message in the
 * product. So a revoked member whose socket is already in the tenant's inbox
 * room keeps receiving `message:new` and `conversation:updated` until that
 * socket happens to close. Suspension whose whole purpose is immediate
 * revocation cannot ship that way.
 *
 * NOT the roster broadcast ADR-027 §15 declined, and the distinction is the
 * whole justification. §15 refused a membership EVENT ON THE WIRE because "a
 * broadcast has no single reader to run `can(role, "member.read")` against".
 * Nothing here reaches a wire: the payload never leaves the process, no
 * connected client is told anything, and the only observable effect is that
 * one person's own connections end. No colleague learns who was suspended, and
 * no customer socket is reachable from here at all — the subscriber matches on
 * the agent identity `socketAuthentication` established, and a widget socket
 * carries a customer principal that can never match a `userId`.
 *
 * ON GENERALIZING. `conversationEvents`'s header invited exactly this question
 * at exactly this point: "the third consumer will be able to see what actually
 * varies between these two files." Now that it exists, the answer is that a
 * shared `domainEvents` bus with a string topic is still the wrong move.
 * `messageEvents` and `conversationEvents` vary in payload and audience; this
 * one varies in payload, audience, AND in what the subscriber DOES — it emits
 * nothing. Abstracting over the subscriber's action would abstract over the
 * thing that varies most. Three small files stay three small files; a fourth
 * consumer can revisit it.
 */

/**
 * What a subscriber receives.
 *
 * Two ids and nothing else — deliberately not a `MembershipDocument`, and
 * deliberately not a role, a status, a name, or an address. The subscriber's
 * whole job is "close this person's connections to this tenant", and a payload
 * carrying more than that would be a payload a future subscriber could start
 * making authorization decisions from (ADR-017 §10's reasoning, applied to an
 * internal event rather than a response).
 *
 * `reason` distinguishes suspension from removal FOR THE LOG ONLY. It reaches
 * no client, because nothing here reaches a client.
 */
export interface MembershipRevokedEvent {
  organizationId: string;
  /** The `User` whose staff access to this organization has ended. */
  userId: string;
  reason: "suspended" | "removed";
}

export type MembershipRevokedListener = (event: MembershipRevokedEvent) => void;

const MEMBERSHIP_REVOKED = "membership.revoked";

/**
 * Node's `EventEmitter` dispatches synchronously, which is why `publish` below
 * guards its listeners: without it, one throwing subscriber would propagate
 * into the awaiting caller and turn a successfully persisted revocation into a
 * 500 — for the person who is already revoked.
 *
 * `subscribe` returns its own unsubscribe rather than expecting callers to
 * reconstruct the function reference, matching both sibling seams: a
 * module-scope emitter with per-instance subscribers is safe only if the
 * subscribers are actually removed, and tests construct and tear down several
 * socket servers in one process.
 */
const emitter = new EventEmitter();

export const membershipEvents = {
  /** Registers a listener and returns the function that removes it. */
  subscribe(listener: MembershipRevokedListener): () => void {
    emitter.on(MEMBERSHIP_REVOKED, listener);
    return () => {
      emitter.off(MEMBERSHIP_REVOKED, listener);
    };
  },

  /**
   * Announces a persisted revocation. Best-effort and never throws, matching
   * `messageEvents.publish` and `conversationEvents.publish` exactly — the
   * membership write is durably stored before this runs, so nothing here may
   * fail the write that produced it.
   *
   * A subscriber's error is logged as an event name and an error class, never
   * as the payload that caused it.
   */
  publish(event: MembershipRevokedEvent): void {
    try {
      emitter.emit(MEMBERSHIP_REVOKED, event);
    } catch (err) {
      logger.error(
        {
          event: "membership.revocation_broadcast_failed",
          organizationId: event.organizationId,
          userId: event.userId,
          err: err instanceof Error ? err.name : "UnknownError",
        },
        "A membership.revoked subscriber threw",
      );
    }
  },

  /** Listener count, for tests that assert a socket server cleaned up after itself. */
  listenerCount(): number {
    return emitter.listenerCount(MEMBERSHIP_REVOKED);
  },
};
