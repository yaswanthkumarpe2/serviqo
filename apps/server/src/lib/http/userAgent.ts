import { MAX_USER_AGENT_LENGTH } from "../../config/constants";

/**
 * Prepares a raw User-Agent header for storage on a Session.
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
 * Truncation is the ONLY transformation applied. The value is not trimmed,
 * normalized, or otherwise altered: a User-Agent is an opaque diagnostic
 * string, and silently rewriting its contents would make the device list
 * disagree with what the client actually sent. An absent header is already
 * `undefined` at the HTTP boundary, so no additional emptiness handling is
 * invented here — an empty header value stays an empty string.
 */
export function normalizeUserAgent(rawUserAgent: string | undefined | null): string | undefined {
  if (typeof rawUserAgent !== "string") return undefined;

  return rawUserAgent.slice(0, MAX_USER_AGENT_LENGTH);
}
