import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectDatabase, disconnectDatabase } from "../src/database/connection";

describe("connectDatabase", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
  });

  afterAll(async () => {
    await disconnectDatabase();
    await mongoServer.stop();
  });

  it("connects to MongoDB and reaches a ready state", async () => {
    await connectDatabase(mongoServer.getUri());
    expect(mongoose.connection.readyState).toBe(1);
  });
});
