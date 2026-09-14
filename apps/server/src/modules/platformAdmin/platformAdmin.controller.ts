import { created, success } from "../../lib/response";

import type { AgentInvitationService } from "./agentInvitation.service";
import type { InviteAgentInput } from "./agentInvitation.validation";
import type { PlatformAdminService } from "./platformAdmin.service";
import type { RequestHandler } from "express";

export interface PlatformAdminControllerDependencies {
  platformAdminService: PlatformAdminService;
  agentInvitationService: AgentInvitationService;
}

/**
 * The operations console's read surface (ADR-032 §8).
 *
 * Thin, like every other controller here: it reads the request, calls one
 * service method, and sends the envelope. Errors are not caught — Express 5
 * forwards a rejected handler promise to the error middleware, which is the
 * single place that turns an error into a response.
 *
 * Every handler was a GET until ADR-034 added exactly one write: inviting an
 * agent. The original rule stands for everything else — there is still no
 * endpoint here that disables an account, deletes a tenant, or reads a
 * conversation, because each of those deserves its own audit trail and its own
 * argument. Adding an agent earned its place because it is the only way agents
 * can exist at all, and it creates rather than destroys.
 */
export function createPlatformAdminController({
  platformAdminService,
  agentInvitationService,
}: PlatformAdminControllerDependencies) {
  const overview: RequestHandler = async (req, res) => {
    success(res, await platformAdminService.getOverview(req.log));
  };

  /**
   * `?limit=` is read straight off the query string and handed to the service,
   * which clamps it.
   *
   * No `validateBody`-style schema for it, unlike every write in this
   * codebase: a bad limit has exactly one sensible answer — serve a sensible
   * page — and returning 400 for `?limit=abc` would turn a typo in a URL into
   * an error page in an operator's console. `Number.parseInt` yields `NaN`
   * there, and `clampLimit` treats `NaN` as "unspecified".
   */
  const organizations: RequestHandler = async (req, res) => {
    const limit = parseLimit(req.query.limit);
    success(res, await platformAdminService.listOrganizations(limit, req.log));
  };

  const users: RequestHandler = async (req, res) => {
    const limit = parseLimit(req.query.limit);
    success(res, await platformAdminService.listUsers(limit, req.log));
  };

  /**
   * Adds an agent and emails them their credentials (ADR-034 §7).
   *
   * `req.body` is safe to assert: `validateBody(inviteAgentSchema)` replaced it
   * with exactly `{ name, email }`, and that schema is `.strict()` — a body
   * carrying `role`, `status` or `emailVerifiedAt` was refused before this
   * handler ran rather than silently stripped.
   *
   * The response carries no password. It exists in one place, the email, and
   * echoing it into an API response would put a working credential into
   * whatever logs or proxies sit between here and the console.
   */
  const inviteAgent: RequestHandler = async (req, res) => {
    const agent = await agentInvitationService.invite(req.body as InviteAgentInput, req.log);
    created(res, { agent });
  };

  return { overview, organizations, users, inviteAgent };
}

/**
 * Turns a query-string value into a number the service can clamp.
 *
 * Express parses `?limit=1&limit=2` into an ARRAY, and `?limit[x]=1` into an
 * object, so the type of `req.query.limit` is genuinely unknown at runtime.
 * Anything that is not a single string collapses to `undefined` — "not
 * specified" — rather than being coerced, because `Number([])` is `0` and
 * silently serving zero rows for a malformed URL is the kind of bug that gets
 * diagnosed as "the console is broken".
 */
function parseLimit(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
