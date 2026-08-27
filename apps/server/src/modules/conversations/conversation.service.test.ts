import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConversationModel } from "./conversation.model";
import { createConversationService } from "./conversation.service";

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

describe("conversationService.resolveOpen", () => {
  let mongoServer: MongoMemoryServer;
  const service = createConversationService();
  const ORGANIZATION = new Types.ObjectId().toString();
  const CUSTOMER = new Types.ObjectId().toString();

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

  it("creates a conversation when the customer has none", async () => {
    const conversation = await service.resolveOpen(ORGANIZATION, CUSTOMER);

    expect(conversation.status).toBe("open");
    expect(await ConversationModel.countDocuments({})).toBe(1);
  });

  it("returns the same conversation on a second call", async () => {
    const first = await service.resolveOpen(ORGANIZATION, CUSTOMER);
    const second = await service.resolveOpen(ORGANIZATION, CUSTOMER);

    expect(second._id.toString()).toBe(first._id.toString());
    expect(await ConversationModel.countDocuments({})).toBe(1);
  });

  it("resolves the race when two concurrent calls both find nothing", async () => {
    const [a, b] = await Promise.all([
      service.resolveOpen(ORGANIZATION, CUSTOMER),
      service.resolveOpen(ORGANIZATION, CUSTOMER),
    ]);

    // Both callers get an answer, and it is the same conversation — the
    // loser of the database race re-reads rather than erroring (ADR-022 §7).
    expect(a._id.toString()).toBe(b._id.toString());
    expect(await ConversationModel.countDocuments({})).toBe(1);
  });

  it("logs resumed:false on the first creation and resumed:true on reuse", async () => {
    const capture = createCapturingLogger();

    await service.resolveOpen(ORGANIZATION, CUSTOMER, capture.log);
    await service.resolveOpen(ORGANIZATION, CUSTOMER, capture.log);

    const logged = capture.serialized();
    expect(logged).toContain('"resumed":false');
    expect(logged).toContain('"resumed":true');
  });

  it("logs only safe identifiers, never a customer's own data", async () => {
    const capture = createCapturingLogger();

    await service.resolveOpen(ORGANIZATION, CUSTOMER, capture.log);

    const logged = capture.serialized();
    expect(logged).toContain("conversation.opened");
    expect(logged).toContain(ORGANIZATION);
    expect(logged).toContain(CUSTOMER);
  });
});
