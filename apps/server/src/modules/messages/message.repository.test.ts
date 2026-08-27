import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MessageModel } from "./message.model";
import { messageRepository } from "./message.repository";

const ORGANIZATION_A = new Types.ObjectId();
const ORGANIZATION_B = new Types.ObjectId();
const CONVERSATION_A = new Types.ObjectId();
const CONVERSATION_B = new Types.ObjectId();
const CUSTOMER_A = new Types.ObjectId();

describe("messageRepository", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await MessageModel.init();
  });

  afterEach(async () => {
    await MessageModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe("create", () => {
    it("persists a customer message", async () => {
      const message = await messageRepository.create({
        organizationId: ORGANIZATION_A,
        conversationId: CONVERSATION_A,
        customerId: CUSTOMER_A,
        senderType: "customer",
        body: "Hello, I have a question.",
      });

      expect(message.senderType).toBe("customer");
      expect(message.body).toBe("Hello, I have a question.");
      expect(message.createdAt).toBeInstanceOf(Date);
    });

    it("has no updatedAt field", async () => {
      const message = await messageRepository.create({
        organizationId: ORGANIZATION_A,
        conversationId: CONVERSATION_A,
        customerId: CUSTOMER_A,
        senderType: "customer",
        body: "Hi",
      });

      expect((message.toObject() as unknown as Record<string, unknown>).updatedAt).toBeUndefined();
    });
  });

  describe("list", () => {
    async function seedMessages(count: number, conversationId = CONVERSATION_A, organizationId = ORGANIZATION_A) {
      const created = [];
      for (let i = 0; i < count; i += 1) {
        created.push(
          await messageRepository.create({
            organizationId,
            conversationId,
            customerId: CUSTOMER_A,
            senderType: "customer",
            body: `Message ${i}`,
          }),
        );
      }
      return created;
    }

    it("returns messages in ascending _id order", async () => {
      const seeded = await seedMessages(5);

      const page = await messageRepository.list(ORGANIZATION_A, CONVERSATION_A, { limit: 10 });

      expect(page.map((m) => m._id.toString())).toEqual(seeded.map((m) => m._id.toString()));
    });

    it("requests limit + 1 rows so the caller can detect a further page", async () => {
      await seedMessages(5);

      const page = await messageRepository.list(ORGANIZATION_A, CONVERSATION_A, { limit: 3 });

      expect(page).toHaveLength(4);
    });

    it("returns fewer than limit + 1 when there is no further page", async () => {
      await seedMessages(2);

      const page = await messageRepository.list(ORGANIZATION_A, CONVERSATION_A, { limit: 10 });

      expect(page).toHaveLength(2);
    });

    it("returns messages strictly after the cursor", async () => {
      const seeded = await seedMessages(5);
      const cursor = seeded[1]!._id.toString();

      const page = await messageRepository.list(ORGANIZATION_A, CONVERSATION_A, { cursor, limit: 10 });

      expect(page.map((m) => m._id.toString())).toEqual(seeded.slice(2).map((m) => m._id.toString()));
    });

    it("does not return another conversation's messages", async () => {
      await seedMessages(3, CONVERSATION_A);
      await seedMessages(2, CONVERSATION_B);

      const page = await messageRepository.list(ORGANIZATION_A, CONVERSATION_A, { limit: 10 });

      expect(page).toHaveLength(3);
    });

    it("does not return another organization's messages for the same conversation id", async () => {
      await seedMessages(3, CONVERSATION_A, ORGANIZATION_A);
      await seedMessages(2, CONVERSATION_A, ORGANIZATION_B);

      const page = await messageRepository.list(ORGANIZATION_A, CONVERSATION_A, { limit: 10 });

      expect(page).toHaveLength(3);
    });
  });
});
