/**
 * Logging primitives shared by every auth service.
 *
 * Extracted from `emailVerification.ts` when login became a second consumer.
 * "Log the error's class, never its message" is a security rule, and a rule
 * like that should exist once — the same reasoning ADR-008 §7 applied to
 * token minting.
 */

/**
 * Minimal structural type for the logger auth services need.
 *
 * Declared here rather than importing Pino's, so a controller can pass
 * `req.log` (carrying the requestId) and a test can pass a capture function,
 * without the production logger being weakened or reconfigured.
 */
export interface AuthLogger {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * Names a failure without carrying its message.
 *
 * A Mongo error's text can quote the offending document — for a duplicate
 * key that includes the indexed value — so only the constructor name is ever
 * logged. It distinguishes "database unreachable" from "constraint violated"
 * during triage and carries no data.
 */
export function failureType(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
