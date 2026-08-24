import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConversationModel } from "./conversation.model";
import { conversationEvents } from "./conversationEvents";
import { createConversationService } from "./conversation.service";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationUpdatedEvent } from "./conversationEvents";

/**
 * Assignment and status at the SERVICE layer (ADR-026 §4, §7, §9).
 *
 * `tests/conversationAssignment.test.ts` proves the routes, the permissions,
 * and the isolation boundaries over real HTTP. This file proves the three
 * things that are hard to see from a response body: the conditional update is
 * genuinely atomic under concurrency, the domain event is published with the
 * right shape AND the right omissions, and the log lines carry safe fields
 * only.
 *
 * The logging assertions in particular can only live here. `LOG_LEVEL` is
 * `silent` for the whole suite (tests/setup.ts), so an HTTP test can prove
 * that a secret is ABSENT from stdout — which it trivially is — but never that
 * the right field is present. An injected logger is the only place that claim
 * is real.
 *
 * Its own file rather than more `describe` blocks in
 * `conversation.service.test.ts`: that file is ADR-022's resolve-or-create and
 * owns one `MongoMemoryServer`, and a second concern sharing its lifecycle
 * hooks would make either suite's failure ambiguous.
 */

function createCapturingLogger() {
  const entries: { payload: Record<string, unknown>; message: string }[] = [];
  const record = (payload: Record<string, unknown>, message: string) => {
    entries.push({ payload, message });
  };
  return {
    log: { info: record, error: record } satisfies AuthLogger,
    serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n"),
  };
}

describe("conversationService assignment and status", () => {
  let mongoServer: MongoMemoryServer;
  const service = createConversationService();

  const ORGANIZATION = new Types.ObjectId().toString();
  const CUSTOMER = new Types.ObjectId().toString();
  const AGENT = new Types.ObjectId().toString();
  const OTHER_AGENT = new Types.ObjectId().toString();
  const OTHER_ORGANIZATION = new Types.ObjectId().toString();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // The partial unique index ADR-022 §3 defines has to actually exist for
    // the reopen-conflict assertions below to mean anything.
    await ConversationModel.init();
  });

  afterEach(async () => {
    await ConversationModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  /** Collects every `conversation.updated` published during one test. */
  function captureEvents() {
    const events: ConversationUpdatedEvent[] = [];
    const unsubscribe = conversationEvents.subscribe((event) => events.push(event));
    return { events, unsubscribe };
  }

  function openConversation(customerId = CUSTOMER) {
    return ConversationModel.create({ organizationId: ORGANIZATION, customerId });
  }

  // ---- claim / release ----

  it("claims an unassigned conversation for the caller", async () => {
    const conversation = await openConversation();

    const claimed = await service.claim(ORGANIZATION, conversation._id.toString(), AGENT);

    expect(claimed.assignedTo!.toString()).toBe(AGENT);
  });

  it("stores null rather than an absent field for an unclaimed conversation", async () => {
    const conversation = await openConversation();

    // `{ assignedTo: null }` is the filter the unassigned queue pages through
    // (ADR-026 §1, §5), and it must match a document nobody has touched.
    expect(conversation.assignedTo).toBeNull();
    expect(await ConversationModel.countDocuments({ assignedTo: null })).toBe(1);
  });

  it("refuses a claim on a conversation another agent holds", async () => {
    const conversation = await openConversation();
    await service.claim(ORGANIZATION, conversation._id.toString(), AGENT);

    await expect(service.claim(ORGANIZATION, conversation._id.toString(), OTHER_AGENT)).rejects.toMatchObject({
      code: "CONVERSATION_ALREADY_ASSIGNED",
      httpStatus: 409,
    });
  });

  it("refuses a release by an agent who does not hold it", async () => {
    const conversation = await openConversation();
    await service.claim(ORGANIZATION, conversation._id.toString(), AGENT);

    await expect(service.release(ORGANIZATION, conversation._id.toString(), OTHER_AGENT)).rejects.toMatchObject({
      code: "CONVERSATION_ALREADY_ASSIGNED",
    });

    expect((await ConversationModel.findById(conversation._id))!.assignedTo!.toString()).toBe(AGENT);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const conversation = await openConversation();
    const id = conversation._id.toString();

    /*
      THE assertion the conditional update exists for (ADR-026 §4). A
      check-then-write would let BOTH settle as fulfilled, with the second
      writer silently overwriting the first — so the losing agent's UI would
      show them as the owner while the database disagreed.
    */
    const outcomes = await Promise.allSettled([
      service.claim(ORGANIZATION, id, AGENT),
      service.claim(ORGANIZATION, id, OTHER_AGENT),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);

    const stored = await ConversationModel.findById(id);
    expect([AGENT, OTHER_AGENT]).toContain(stored!.assignedTo!.toString());
  });

  it("is idempotent for a re-claim and for a release of an unassigned conversation", async () => {
    const conversation = await openConversation();
    const id = conversation._id.toString();

    await service.claim(ORGANIZATION, id, AGENT);
    expect((await service.claim(ORGANIZATION, id, AGENT)).assignedTo!.toString()).toBe(AGENT);

    await service.release(ORGANIZATION, id, AGENT);
    expect((await service.release(ORGANIZATION, id, AGENT)).assignedTo).toBeNull();
  });

  it("raises the opaque not-found refusal for a conversation in another tenant", async () => {
    const conversation = await openConversation();

    await expect(service.claim(OTHER_ORGANIZATION, conversation._id.toString(), AGENT)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("raises the identical refusal for a conversation that does not exist", async () => {
    const missing = new Types.ObjectId().toString();

    // Indistinguishable from the cross-tenant refusal above (ADR-025 §10,
    // ADR-026 §12): the 404 comes from the query missing, not from a branch
    // comparing tenants — so there is no branch to drift.
    await expect(service.claim(ORGANIZATION, missing, AGENT)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("does not write across a tenant boundary even when the conversation id is real", async () => {
    const conversation = await openConversation();

    await expect(service.release(OTHER_ORGANIZATION, conversation._id.toString(), AGENT)).rejects.toThrow();
    await expect(service.setStatus(OTHER_ORGANIZATION, conversation._id.toString(), "closed")).rejects.toThrow();

    const stored = await ConversationModel.findById(conversation._id);
    expect(stored!.status).toBe("open");
    expect(stored!.organizationId.toString()).toBe(ORGANIZATION);
  });

  // ---- status ----

  it("closes and reopens, idempotently in both directions", async () => {
    const conversation = await openConversation();
    const id = conversation._id.toString();

    expect((await service.setStatus(ORGANIZATION, id, "closed")).status).toBe("closed");
    expect((await service.setStatus(ORGANIZATION, id, "closed")).status).toBe("closed");
    expect((await service.setStatus(ORGANIZATION, id, "open")).status).toBe("open");
    expect((await service.setStatus(ORGANIZATION, id, "open")).status).toBe("open");
  });

  it("translates the unique-index violation when reopening would make a second open conversation", async () => {
    const first = await openConversation();
    await service.setStatus(ORGANIZATION, first._id.toString(), "closed");

    // The customer writes in again — ADR-022 §7's resolve-or-create, which
    // creates a NEW open conversation because the old one is closed.
    await service.resolveOpen(ORGANIZATION, CUSTOMER);

    /*
      ADR-022 §3's partial unique index refusing the write, surfaced as a
      named 409 rather than as the raw duplicate-key error a caller cannot act
      on (ADR-026 §7). Absorbing it instead would mean closing the newer
      conversation — destroying a thread the customer is actively using.
    */
    await expect(service.setStatus(ORGANIZATION, first._id.toString(), "open")).rejects.toMatchObject({
      code: "CONVERSATION_REOPEN_CONFLICT",
      httpStatus: 409,
    });
  });

  it("leaves both conversations exactly as they were when a reopen conflicts", async () => {
    const first = await openConversation();
    await service.setStatus(ORGANIZATION, first._id.toString(), "closed");
    const second = await service.resolveOpen(ORGANIZATION, CUSTOMER);

    await expect(service.setStatus(ORGANIZATION, first._id.toString(), "open")).rejects.toThrow();

    expect((await ConversationModel.findById(first._id))!.status).toBe("closed");
    expect((await ConversationModel.findById(second._id))!.status).toBe("open");
  });

  it("allows reopening once the newer conversation has itself been closed", async () => {
    const first = await openConversation();
    await service.setStatus(ORGANIZATION, first._id.toString(), "closed");
    const second = await service.resolveOpen(ORGANIZATION, CUSTOMER);

    await service.setStatus(ORGANIZATION, second._id.toString(), "closed");

    const reopened = await service.setStatus(ORGANIZATION, first._id.toString(), "open");
    expect(reopened.status).toBe("open");
  });

  it("does not conflict with another customer's open conversation", async () => {
    const otherCustomer = new Types.ObjectId().toString();
    const mine = await openConversation();
    await service.setStatus(ORGANIZATION, mine._id.toString(), "closed");
    await service.resolveOpen(ORGANIZATION, otherCustomer);

    // The index is scoped by customer as well as tenant (ADR-022 §3), so a
    // different customer's open conversation is not a collision.
    const reopened = await service.setStatus(ORGANIZATION, mine._id.toString(), "open");
    expect(reopened.status).toBe("open");
  });

  // ---- the domain event ----

  it("publishes conversation.updated for each of claim, close, reopen, and release", async () => {
    const conversation = await openConversation();
    const id = conversation._id.toString();
    const capture = captureEvents();

    try {
      await service.claim(ORGANIZATION, id, AGENT);
      await service.setStatus(ORGANIZATION, id, "closed");
      await service.setStatus(ORGANIZATION, id, "open");
      await service.release(ORGANIZATION, id, AGENT);
    } finally {
      capture.unsubscribe();
    }

    expect(capture.events).toHaveLength(4);
    expect(capture.events.map((event) => event.conversation.status)).toEqual(["open", "closed", "open", "open"]);
    expect(capture.events[0]!.conversation.assignedTo).toEqual({ id: AGENT, name: null });
    expect(capture.events[3]!.conversation.assignedTo).toBeNull();
  });

  it("publishes no event when an operation is refused", async () => {
    const conversation = await openConversation();
    const id = conversation._id.toString();
    await service.claim(ORGANIZATION, id, AGENT);

    const capture = captureEvents();
    try {
      await expect(service.claim(ORGANIZATION, id, OTHER_AGENT)).rejects.toThrow();
      await expect(service.claim(OTHER_ORGANIZATION, id, AGENT)).rejects.toThrow();
    } finally {
      capture.unsubscribe();
    }

    expect(capture.events).toHaveLength(0);
  });

  it("carries the tenant and no customer in the event payload", async () => {
    const conversation = await openConversation();
    const capture = captureEvents();

    try {
      await service.claim(ORGANIZATION, conversation._id.toString(), AGENT);
    } finally {
      capture.unsubscribe();
    }

    const [event] = capture.events;
    expect(event!.organizationId).toBe(ORGANIZATION);
    expect(event!.conversationId).toBe(conversation._id.toString());

    /*
      Deliberately narrower than the inbox row (ADR-026 §9): no customer,
      because it did not change and every connected agent socket would
      otherwise receive a customer's identity on every claim.
    */
    expect(event!.conversation).not.toHaveProperty("customer");
    expect(JSON.stringify(event)).not.toContain(CUSTOMER);
  });

  it("never carries an assignee name over the event, because a broadcast has no reader", async () => {
    const conversation = await openConversation();
    const capture = captureEvents();

    try {
      await service.claim(ORGANIZATION, conversation._id.toString(), AGENT);
    } finally {
      capture.unsubscribe();
    }

    // There is no role to run `can(role, "member.read")` against here, and a
    // payload that cannot make that check must not carry what it protects
    // (ADR-026 §11).
    expect(capture.events[0]!.conversation.assignedTo!.name).toBeNull();
  });

  it("does not fail a claim when a subscriber throws", async () => {
    const conversation = await openConversation();
    const unsubscribe = conversationEvents.subscribe(() => {
      throw new Error("subscriber exploded");
    });

    try {
      // The state change is durably persisted before the event is published,
      // so nothing in the broadcast may fail the write that produced it
      // (ADR-026 §9).
      const claimed = await service.claim(ORGANIZATION, conversation._id.toString(), AGENT);
      expect(claimed.assignedTo!.toString()).toBe(AGENT);
    } finally {
      unsubscribe();
    }

    expect((await ConversationModel.findById(conversation._id))!.assignedTo!.toString()).toBe(AGENT);
  });

  it("removes its listener when unsubscribed", () => {
    const before = conversationEvents.listenerCount();
    const unsubscribe = conversationEvents.subscribe(() => {});
    expect(conversationEvents.listenerCount()).toBe(before + 1);

    unsubscribe();
    expect(conversationEvents.listenerCount()).toBe(before);
  });

  // ---- logging ----

  it("logs the acting user and safe identifiers on an assignment change", async () => {
    const conversation = await openConversation();
    const capture = createCapturingLogger();

    await service.claim(ORGANIZATION, conversation._id.toString(), AGENT, capture.log);
    await service.release(ORGANIZATION, conversation._id.toString(), AGENT, capture.log);

    const logged = capture.serialized();
    expect(logged).toContain("conversation.claimed");
    expect(logged).toContain("conversation.released");
    // An operator needs to know who took a conversation (ADR-026 §12).
    expect(logged).toContain(AGENT);
    expect(logged).toContain(ORGANIZATION);
  });

  it("logs the two status transitions under distinct event names", async () => {
    const conversation = await openConversation();
    const capture = createCapturingLogger();
    const id = conversation._id.toString();

    await service.setStatus(ORGANIZATION, id, "closed", capture.log);
    await service.setStatus(ORGANIZATION, id, "open", capture.log);

    const logged = capture.serialized();
    expect(logged).toContain("conversation.closed");
    expect(logged).toContain("conversation.reopened");
  });

  it("logs no customer identifier on an assignment change", async () => {
    const conversation = await openConversation();
    const capture = createCapturingLogger();

    await service.claim(ORGANIZATION, conversation._id.toString(), AGENT, capture.log);

    // The customer is derivable from the conversation for anyone with database
    // access and does not belong in an agent-action audit line — the same
    // omission `messageService.createFromAgent` already makes.
    expect(capture.serialized()).not.toContain(CUSTOMER);
  });
});
