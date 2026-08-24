import http from "node:http";

import { createApp } from "./app";
import { connectDatabase } from "./database/connection";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { createSocketServer } from "./realtime/createSocketServer";

async function main() {
  try {
    await connectDatabase();
  } catch (err) {
    logger.fatal({ err }, "Failed to connect to MongoDB - exiting");
    process.exit(1);
  }

  const app = createApp();
  /*
    Socket.IO attaches to the same HTTP server Express already owns (ADR-023
    §2) — one process, one port, for both the REST API and the real-time
    transport. `createApp` keeps building a bare Express app for
    `supertest` (ADR-007's own "no listening socket required" shape); only
    `main.ts`'s boot path wraps it in an `http.Server`.
  */
  const httpServer = http.createServer(app);
  createSocketServer(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, `Serviqo server listening on port ${env.PORT}`);
  });
}

void main();
