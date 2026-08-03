import pino from "pino";

import { env } from "../env";

/**
 * Single shared Pino instance. Every log line carries `service` + `level`
 * + `time` by default; per-request `requestId`/`correlationId` are added
 * via a child logger (see middleware/requestContext.ts).
 *
 * Never log: passwords, JWTs, refresh tokens, API secrets, verification
 * tokens, reset tokens — redact paths below cover the field names those
 * values will appear under once auth exists, applied now so nothing has
 * to remember to add them later.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "serviqo-server" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.resetToken",
      "*.verificationToken",
    ],
    censor: "[REDACTED]",
  },
});
