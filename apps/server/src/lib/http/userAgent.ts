import { MAX_USER_AGENT_LENGTH } from "../../config/constants";

/**
 * Normalizes a raw User-Agent header for storage on a Session.
 *
 * Policy: optional diagnostic metadata must NEVER cause an otherwise-valid
 * login to fail. So this truncates rather than rejects — the informative part
 * of a user-agent (browser and OS) is at the front, and real strings are
 * 100-200 characters, so anything past the bound is noise or abuse.
 *
 * This is a deliberate divergence from the persistence layer's usual
 * "reject, don't silently mutate" stance, which is correct for security-
 * relevant identifiers such as slug and email but wrong for a field whose
 * stated requirement is that it can never block authentication. The session
 * schema keeps its `maxlength` validation as defense in depth, asserting
 * that this helper ran.
 *
 * Missing, empty, or whitespace-only input yields `undefined` — storing a
 * blank string would show an empty row in the user's own device list, which
 * is worse than showing nothing.
 */
export function normalizeUserAgent(rawUserAgent: string | undefined | null): string | undefined {
  if (typeof rawUserAgent !== "string") return undefined;

  const trimmed = rawUserAgent.trim();
  if (trimmed.length === 0) return undefined;

  return trimmed.slice(0, MAX_USER_AGENT_LENGTH);
}
