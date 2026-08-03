import type { logger } from "../lib/logger";

declare global {
  namespace Express {
    interface Request {
      log: typeof logger;
    }
  }
}

export {};
