import type { logger } from "../lib/logger";
import type { AccessTokenPrincipal } from "../modules/auth/accessToken";

declare global {
  namespace Express {
    interface Request {
      log: typeof logger;
      /**
       * Who is calling, set by `requireAccessToken` and by nothing else.
       *
       * Optional because most routes have none: a route that needs a
       * principal mounts the middleware that establishes one, and TypeScript
       * stops a handler assuming it otherwise (ADR-015 consequences).
       */
      principal?: AccessTokenPrincipal;
    }
  }
}

export {};
