import { createApp } from "./app";
import { connectDatabase } from "./database/connection";
import { env } from "./lib/env";
import { logger } from "./lib/logger";

async function main() {
  try {
    await connectDatabase();
  } catch (err) {
    logger.fatal({ err }, "Failed to connect to MongoDB - exiting");
    process.exit(1);
  }

  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, `Serviqo server listening on port ${env.PORT}`);
  });
}

void main();
