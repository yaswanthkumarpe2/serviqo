import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConversationNotAccessibleError } from "../../lib/errors";
import { ConversationModel } from "../conversations/conversation.model";
import { conversationRepository } from "../conversations/conversation.repository";
import { MessageModel } from "./message.model";
import { createMessageService } from "./message.service";

import type { AuthLogger } from "../auth/authLogging";

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

describe("messageService", () => {
  let mongoServer: MongoMemoryServer;
  const service = createMessageService();

  const ORGANIZATION = new Types.ObjectId().toString();
  const OTHER_ORGANIZATION = new Types.ObjectId().toString();
  const CUSTOMER = new Types.ObjectId().toString();
  const OTHER_CUSTOMER = new Types.ObjectId().toString();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await ConversationModel.init();
    await MessageModel.init();
  });

  afterEach(async () => {
    await Promise.all([ConversationModel.deleteMany({}), MessageModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  async function openConversation(organizationId = ORGANIZATION, customerId = CUSTOMER) {
    return conversationRepository.create(organizationId, customerId);
  }

  describe("create", () => {
    it("persists a message with senderType customer", async () => {
      const conversation = await openConversation();

      const message = await service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), "Hello there");

      expect(message.senderType).toBe("customer");
      expect(message.body).toBe("Hello there");
      expect(await MessageModel.countDocuments({})).toBe(1);
    });

    it("updates the conversation's lastMessageAt", async () => {
      const conversation = await openConversation();

      const message = await service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), "Hi");

      const reloaded = await ConversationModel.findById(conversation._id);
      expect(reloaded!.lastMessageAt.getTime()).toBe(message.createdAt.getTime());
    });

    it("rejects sending into a conversation that does not exist", async () => {
      await expect(
        service.create(ORGANIZATION, CUSTOMER, new Types.ObjectId().toString(), "Hi"),
      ).rejects.toBeInstanceOf(ConversationNotAccessibleError);
      expect(await MessageModel.countDocuments({})).toBe(0);
    });

    it("rejects sending into another customer's conversation", async () => {
      const conversation = await openConversation(ORGANIZATION, OTHER_CUSTOMER);

      await expect(
        service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), "Hi"),
      ).rejects.toBeInstanceOf(ConversationNotAccessibleError);
    });

    it("rejects sending into another organization's conversation", async () => {
      const conversation = await openConversation(OTHER_ORGANIZATION, CUSTOMER);

      await expect(
        service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), "Hi"),
      ).rejects.toBeInstanceOf(ConversationNotAccessibleError);
    });

    it("gives an unknown id and a real id belonging to another customer the identical error", async () => {
      const foreign = await openConversation(ORGANIZATION, OTHER_CUSTOMER);

      const unknownAttempt = service.create(ORGANIZATION, CUSTOMER, new Types.ObjectId().toString(), "Hi");
      const foreignAttempt = service.create(ORGANIZATION, CUSTOMER, foreign._id.toString(), "Hi");

      const [unknownErr, foreignErr] = await Promise.allSettled([unknownAttempt, foreignAttempt]);
      expect(unknownErr.status).toBe("rejected");
      expect(foreignErr.status).toBe("rejected");
      const a = (unknownErr as PromiseRejectedResult).reason as ConversationNotAccessibleError;
      const b = (foreignErr as PromiseRejectedResult).reason as ConversationNotAccessibleError;
      expect(a.httpStatus).toBe(b.httpStatus);
      expect(a.code).toBe(b.code);
      expect(a.message).toBe(b.message);
    });

    it("logs message.created with safe identifiers and never the body", async () => {
      const conversation = await openConversation();
      const capture = createCapturingLogger();

      await service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), "SENTINEL_BODY_TEXT", capture.log);

      const logged = capture.serialized();
      expect(logged).toContain("message.created");
      expect(logged).toContain(ORGANIZATION);
      expect(logged).toContain(CUSTOMER);
      expect(logged).not.toContain("SENTINEL_BODY_TEXT");
    });
  });

  describe("list", () => {
    it("returns the conversation's messages", async () => {
      const conversation = await openConversation();
      await service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), "one");
      await service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), "two");

      const page = await service.list(ORGANIZATION, CUSTOMER, conversation._id.toString(), { limit: 10 });

      expect(page.messages.map((m) => m.body)).toEqual(["one", "two"]);
      expect(page.nextCursor).toBeNull();
    });

    it("paginates with a cursor", async () => {
      const conversation = await openConversation();
      for (let i = 0; i < 5; i += 1) {
        await service.create(ORGANIZATION, CUSTOMER, conversation._id.toString(), `message ${i}`);
      }

      const firstPage = await service.list(ORGANIZATION, CUSTOMER, conversation._id.toString(), { limit: 2 });
      expect(firstPage.messages).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await service.list(ORGANIZATION, CUSTOMER, conversation._id.toString(), {
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.messages.map((m) => m.body)).toEqual(["message 2", "message 3"]);
      expect(secondPage.nextCursor).not.toBeNull();

      const thirdPage = await service.list(ORGANIZATION, CUSTOMER, conversation._id.toString(), {
        limit: 2,
        cursor: secondPage.nextCursor!,
      });
      expect(thirdPage.messages.map((m) => m.body)).toEqual(["message 4"]);
      expect(thirdPage.nextCursor).toBeNull();
    });

    it("rejects listing another customer's conversation", async () => {
      const conversation = await openConversation(ORGANIZATION, OTHER_CUSTOMER);

      await expect(
        service.list(ORGANIZATION, CUSTOMER, conversation._id.toString(), { limit: 10 }),
      ).rejects.toBeInstanceOf(ConversationNotAccessibleError);
    });

    it("rejects listing another organization's conversation", async () => {
      const conversation = await openConversation(OTHER_ORGANIZATION, CUSTOMER);

      await expect(
        service.list(ORGANIZATION, CUSTOMER, conversation._id.toString(), { limit: 10 }),
      ).rejects.toBeInstanceOf(ConversationNotAccessibleError);
    });
  });
});
