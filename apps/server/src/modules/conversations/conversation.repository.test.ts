import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConversationModel } from "./conversation.model";
import { conversationRepository } from "./conversation.repository";

const ORGANIZATION_A = new Types.ObjectId();
const ORGANIZATION_B = new Types.ObjectId();
const CUSTOMER_A = new Types.ObjectId();
const CUSTOMER_B = new Types.ObjectId();

describe("conversationRepository", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await ConversationModel.init();
  });

  afterEach(async () => {
    await ConversationModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe("create", () => {
    it("creates an open conversation for a customer", async () => {
      const conversation = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      expect(conversation.organizationId.toString()).toBe(ORGANIZATION_A.toString());
      expect(conversation.customerId.toString()).toBe(CUSTOMER_A.toString());
      expect(conversation.status).toBe("open");
    });

    it("defaults lastMessageAt to creation time", async () => {
      const before = Date.now();
      const conversation = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      expect(conversation.lastMessageAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("rejects a second open conversation for the same customer at the database level", async () => {
      await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      await expect(conversationRepository.create(ORGANIZATION_A, CUSTOMER_A)).rejects.toMatchObject({ code: 11000 });
    });

    it("allows a second open conversation once the first is closed", async () => {
      const first = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);
      await ConversationModel.updateOne({ _id: first._id }, { $set: { status: "closed" } });

      await expect(conversationRepository.create(ORGANIZATION_A, CUSTOMER_A)).resolves.toBeDefined();
    });

    it("allows the same customer an open conversation in a different organization", async () => {
      await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      await expect(conversationRepository.create(ORGANIZATION_B, CUSTOMER_A)).resolves.toBeDefined();
    });
  });

  describe("findOpenByCustomer", () => {
    it("finds the open conversation", async () => {
      const created = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      const found = await conversationRepository.findOpenByCustomer(ORGANIZATION_A, CUSTOMER_A);

      expect(found!._id.toString()).toBe(created._id.toString());
    });

    it("returns null when the customer has none", async () => {
      expect(await conversationRepository.findOpenByCustomer(ORGANIZATION_A, CUSTOMER_A)).toBeNull();
    });

    it("does not find a closed conversation", async () => {
      const created = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);
      await ConversationModel.updateOne({ _id: created._id }, { $set: { status: "closed" } });

      expect(await conversationRepository.findOpenByCustomer(ORGANIZATION_A, CUSTOMER_A)).toBeNull();
    });

    it("does not find another customer's open conversation", async () => {
      await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      expect(await conversationRepository.findOpenByCustomer(ORGANIZATION_A, CUSTOMER_B)).toBeNull();
    });

    it("does not find the same customer's conversation in another organization", async () => {
      await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      expect(await conversationRepository.findOpenByCustomer(ORGANIZATION_B, CUSTOMER_A)).toBeNull();
    });
  });

  describe("findByIdForCustomer", () => {
    it("finds a conversation scoped by all three ids", async () => {
      const created = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      const found = await conversationRepository.findByIdForCustomer(created._id, ORGANIZATION_A, CUSTOMER_A);

      expect(found!._id.toString()).toBe(created._id.toString());
    });

    it("returns null for an unknown id", async () => {
      expect(
        await conversationRepository.findByIdForCustomer(new Types.ObjectId(), ORGANIZATION_A, CUSTOMER_A),
      ).toBeNull();
    });

    // The enumeration-resistance boundary (ADR-022 §8): a real id under the
    // wrong organization or the wrong customer must be exactly as inert as an
    // unknown one — none of these three cases may distinguish itself from
    // "not found".
    it("returns null for a real id under the wrong organization", async () => {
      const created = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      expect(await conversationRepository.findByIdForCustomer(created._id, ORGANIZATION_B, CUSTOMER_A)).toBeNull();
    });

    it("returns null for a real id under the wrong customer", async () => {
      const created = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      expect(await conversationRepository.findByIdForCustomer(created._id, ORGANIZATION_A, CUSTOMER_B)).toBeNull();
    });
  });

  describe("touchLastMessageAt", () => {
    it("updates lastMessageAt and returns the updated document", async () => {
      const created = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);
      const when = new Date(created.lastMessageAt.getTime() + 60_000);

      const updated = await conversationRepository.touchLastMessageAt(created._id, ORGANIZATION_A, when);

      expect(updated!.lastMessageAt.getTime()).toBe(when.getTime());
    });

    it("returns null rather than writing across a tenant boundary", async () => {
      const created = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);

      const result = await conversationRepository.touchLastMessageAt(created._id, ORGANIZATION_B, new Date());

      expect(result).toBeNull();
      const unchanged = await ConversationModel.findById(created._id);
      expect(unchanged!.lastMessageAt.getTime()).toBe(created.lastMessageAt.getTime());
    });
  });

  /**
   * ADR-027 §10 — the sweep ADR-026 §15 said did not exist:
   *
   *   > A conversation assigned to someone whose membership was revoked stays
   *   > assigned to them … Nothing sweeps `assignedTo` when a membership ends.
   *
   * Unconditional on the caller, unlike `releaseForUser`, whose "null or me"
   * precondition is exactly what made a departed member's queue unreleasable by
   * anyone. Still scoped by `organizationId`, so a person who works in two
   * tenants keeps their work in the tenant they were not removed from.
   */
  describe("releaseAllForUser", () => {
    const AGENT_A = new Types.ObjectId();
    const AGENT_B = new Types.ObjectId();

    async function assignedConversation(
      organizationId: Types.ObjectId,
      customerId: Types.ObjectId,
      userId: Types.ObjectId,
    ) {
      const conversation = await conversationRepository.create(organizationId, customerId);
      return conversationRepository.claimForUser(conversation._id, organizationId, userId);
    }

    it("clears assignedTo on every conversation the user holds in that tenant", async () => {
      const first = await assignedConversation(ORGANIZATION_A, CUSTOMER_A, AGENT_A);
      const second = await assignedConversation(ORGANIZATION_A, CUSTOMER_B, AGENT_A);

      const released = await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A);

      expect(released).toHaveLength(2);
      for (const id of [first!._id, second!._id]) {
        expect((await ConversationModel.findById(id))!.assignedTo).toBeNull();
      }
    });

    it("returns the affected documents, already reflecting the release", async () => {
      await assignedConversation(ORGANIZATION_A, CUSTOMER_A, AGENT_A);

      const released = await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A);

      // The caller projects these into conversation.updated events, so they
      // must carry the post-release state rather than the pre-release one.
      expect(released[0]!.assignedTo).toBeNull();
    });

    it("leaves another agent's conversations alone", async () => {
      const mine = await assignedConversation(ORGANIZATION_A, CUSTOMER_A, AGENT_A);
      const theirs = await assignedConversation(ORGANIZATION_A, CUSTOMER_B, AGENT_B);

      await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A);

      expect((await ConversationModel.findById(mine!._id))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(theirs!._id))!.assignedTo!.toString()).toBe(AGENT_B.toString());
    });

    it("does not reach across a tenant boundary — the same user in another organization keeps their work", async () => {
      const inA = await assignedConversation(ORGANIZATION_A, CUSTOMER_A, AGENT_A);
      const inB = await assignedConversation(ORGANIZATION_B, CUSTOMER_A, AGENT_A);

      await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A);

      expect((await ConversationModel.findById(inA!._id))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(inB!._id))!.assignedTo!.toString()).toBe(AGENT_A.toString());
    });

    it("returns an empty list when the user holds nothing, without writing", async () => {
      const theirs = await assignedConversation(ORGANIZATION_A, CUSTOMER_A, AGENT_B);

      expect(await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A)).toEqual([]);
      expect((await ConversationModel.findById(theirs!._id))!.assignedTo!.toString()).toBe(AGENT_B.toString());
    });

    it("releases closed conversations too — status is not part of the filter", async () => {
      const conversation = await conversationRepository.create(ORGANIZATION_A, CUSTOMER_A);
      await conversationRepository.claimForUser(conversation._id, ORGANIZATION_A, AGENT_A);
      await conversationRepository.setStatus(conversation._id, ORGANIZATION_A, "closed");

      const released = await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A);

      expect(released).toHaveLength(1);
      expect(released[0]!.status).toBe("closed");
      expect(released[0]!.assignedTo).toBeNull();
    });

    it("is idempotent — a second call finds nothing left to release", async () => {
      await assignedConversation(ORGANIZATION_A, CUSTOMER_A, AGENT_A);

      expect(await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A)).toHaveLength(1);
      expect(await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A)).toEqual([]);
    });

    it("touches no other field — status and lastMessageAt survive the release", async () => {
      const created = await assignedConversation(ORGANIZATION_A, CUSTOMER_A, AGENT_A);

      await conversationRepository.releaseAllForUser(ORGANIZATION_A, AGENT_A);

      const after = await ConversationModel.findById(created!._id);
      expect(after!.status).toBe("open");
      expect(after!.lastMessageAt.getTime()).toBe(created!.lastMessageAt.getTime());
      expect(after!.customerId.toString()).toBe(CUSTOMER_A.toString());
    });
  });
});
