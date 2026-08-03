import mongoose from "mongoose";

import { env } from "../lib/env";
import { logger } from "../lib/logger";

const dbLogger = logger.child({ module: "database" });

let listenersAttached = false;

function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on("connected", () => dbLogger.info("MongoDB connected"));
  mongoose.connection.on("error", (err) => dbLogger.error({ err }, "MongoDB connection error"));
  mongoose.connection.on("disconnected", () => dbLogger.warn("MongoDB disconnected"));
}

/**
 * Connects to MongoDB. Accepts an explicit URI (used by tests, e.g. an
 * in-memory MongoDB instance) — defaults to the validated env value for
 * normal server boot.
 */
export async function connectDatabase(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  attachConnectionListeners();
  return mongoose.connect(uri);
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
