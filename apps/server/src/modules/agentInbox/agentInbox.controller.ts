import { ValidationError } from "../../lib/errors";
import { uploadedFileFrom } from "../attachments/attachment.routes";
import { attachmentService } from "../attachments/attachment.service";
import { created, success } from "../../lib/response";
import { customerRepository } from "../customers/customer.repository";
import { membershipRepository } from "../memberships/membership.repository";
import { can } from "../memberships/permissions";
import { userRepository } from "../users/user.repository";
import { toMessageResponse } from "../widget/widgetResponses";
import { toInboxConversationResponse } from "./agentInbox.responses";
import {
  OBJECT_ID_PATTERN,
  decodeConversationCursor,
  listAgentMessagesQuerySchema,
  listConversationsQuerySchema,
} from "./agentInbox.validation";

import type { ConversationDocument } from "../conversations/conversation.model";
import type { ConversationListFilter } from "../conversations/conversation.repository";
import type { ConversationService } from "../conversations/conversation.service";
import type { MembershipRole } from "../memberships/membership.model";
import type { MessageService } from "../messages/message.service";
import type {
  UpdateConversationTagsInput,
  SendAgentMessageInput,
  UpdateAssignmentInput,
  UpdateConversationStatusInput,
} from "./agentInbox.validation";
import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export interface AgentInboxControllerDependencies {
  conversationService: ConversationService;
  messageService: MessageService;
}

/**
 * Translates request → service → response for the agent inbox (ADR-025 §3),
 * and nothing else — the contract every controller in this codebase follows.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error into
 * a response.
 *
 * Note what these handlers never read: `req.body.organizationId`,
 * `req.query.organizationId`, `req.body.customerId`, `req.body.senderType`.
 * The tenant comes from `req.organizationContext`, which `requireOrganization`
 * built from the path segment after proving membership (ADR-017 §1, §5); the
 * customer comes from a conversation document; `senderType` is a literal
 * inside the service (ADR-025 §6). None of the three has a client-reachable
 * source.
 */
export function createAgentInboxController({
  conversationService,
  messageService,
}: AgentInboxControllerDependencies) {
  /**
   * Guards `:conversationId` before any service or repository call touches
   * it — the identical helper `widget.controller.ts` applies, for the
   * identical reason: a malformed value reaching `Mongoose.findOne` raises a
   * `CastError`, which `errorHandler` turns into a generic 500, reporting a
   * client's mistyped URL as a server fault.
   *
   * Answering `400` specifically here is safe: it depends only on the
   * submitted string's shape, never on whether any conversation exists, so it
   * is not an existence oracle (ADR-025 §10).
   */
  function requireWellFormedConversationId(value: string | string[] | undefined): string {
    if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
      throw new ValidationError("Request validation failed", [
        { field: "conversationId", message: "conversationId is not a valid id" },
      ]);
    }
    return value;
  }

  /**
   * Parses a query string against a schema, raising the same
   * `400 VALIDATION_ERROR` shape `middleware/validate.ts` produces for a
   * body.
   *
   * Query parsing happens here rather than in a `validateQuery` middleware
   * because Express 5 exposes `req.query` through a getter with no setter, so
   * such a middleware would have nowhere to write its result — the limitation
   * `widget.controller.ts` already documents and works around identically.
   */
  function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
    const parsed = schema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError(
        "Request validation failed",
        parsed.error.issues.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.map(String).join(".") : "query",
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }

  /**
   * Resolves the conversations' assignees to what THIS reader may see
   * (ADR-026 §11).
   *
   * The disclosure decision lives here and nowhere else. `member.read` gates
   * "see who else works here", and the `agent` role does not hold it — so
   * rendering colleague names into every agent's inbox would hand that role,
   * through a conversation projection, exactly what the permission table
   * withholds from it.
   *
   * `can()` is the boolean form `permissions.ts` exports for precisely this:
   * "a controller shaping a response to what the reader may see". The role it
   * is given came from the `Membership` document `requireOrganization` read on
   * this request (ADR-017 §5), never from a client.
   *
   * A reader without `member.read` costs ZERO queries — the lookup is skipped
   * entirely, not performed and then discarded — so the path that discloses
   * less is also the cheaper one.
   *
   * Two batched, tenant-scoped queries otherwise, in an order that is the
   * security property: memberships FIRST, because `Conversation.assignedTo`
   * is a `User` id carrying no tenancy of its own (ADR-026 §1), so this is
   * what turns "the document says this user" into "the server proved this
   * user works here". An assignee whose membership has since been revoked
   * survives as `{ id, name: null }` rather than as a name from outside the
   * tenant's current roster.
   */
  async function resolveAssignees(
    conversations: ConversationDocument[],
    organizationId: string,
    role: MembershipRole,
  ): Promise<Map<string, { id: string; name: string | null }>> {
    const assigneeIds = [
      ...new Set(
        conversations
          .map((conversation) => conversation.assignedTo)
          .filter((id): id is NonNullable<typeof id> => id !== null && id !== undefined)
          .map((id) => id.toString()),
      ),
    ];

    if (assigneeIds.length === 0) return new Map();

    /*
      Names are shown to every member who can read conversations (ADR-042 §2,
      amending ADR-026 §11): notes and @mentions already name colleagues, and
      "Assigned to another agent" beside a note signed by that same agent hid
      nothing. Emails, roles and status stay behind `member.read`.
    */
    if (!can(role, "conversation.read")) {
      return new Map(assigneeIds.map((id) => [id, { id, name: null }]));
    }

    const memberships = await membershipRepository.findActiveByOrganizationAndUsers(organizationId, assigneeIds);
    const users = await userRepository.findByIds([...memberships.keys()]);

    return new Map(
      assigneeIds.map((id) => [id, { id, name: users.get(id)?.name ?? null }]),
    );
  }

  /** One conversation's assignee, as this reader may see it. `null` when unassigned. */
  function assigneeFor(
    conversation: ConversationDocument,
    assignees: Map<string, { id: string; name: string | null }>,
  ): { id: string; name: string | null } | null {
    const assignedTo = conversation.assignedTo;
    if (assignedTo === null || assignedTo === undefined) return null;
    return assignees.get(assignedTo.toString()) ?? null;
  }

  /**
   * Turns the validated `assignee` query value into a repository filter
   * (ADR-026 §5).
   *
   * `"me"` becomes the VERIFIED caller's id — read from `req.principal`, which
   * `requireAccessToken` derived from a signed token — and never a value the
   * query string carried. That is why the schema offers two literals rather
   * than a user id: the only identity this filter can name is one the server
   * already proved.
   */
  function toListFilter(
    query: { status?: "open" | "closed"; assignee?: "me" | "unassigned"; tag?: string },
    userId: string,
  ): ConversationListFilter | undefined {
    if (query.status === undefined && query.assignee === undefined && query.tag === undefined) return undefined;

    return {
      ...(query.tag === undefined || query.tag.length === 0 ? {} : { tag: query.tag }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.assignee === undefined
        ? {}
        : { assignee: query.assignee === "unassigned" ? { kind: "unassigned" as const } : { kind: "user" as const, userId } }),
    };
  }

  /**
   * Lists the tenant's conversations, most recently active first
   * (ADR-025 §5).
   *
   * `req.organizationContext` is safe to assert: `requireOrganization` set it
   * or this handler was never reached, and `requirePermission` refused after
   * that unless the caller's role holds `conversation.read`.
   *
   * Customers are fetched in ONE batched, tenant-scoped query rather than one
   * per row (ADR-025 §7) — and scoped by the same `organizationId`, so a
   * conversation whose `customerId` somehow pointed outside the tenant would
   * render with a null customer rather than reaching across the boundary.
   */
  const listConversations: RequestHandler = async (req, res) => {
    const { organizationId, role } = req.organizationContext!;
    const { userId } = req.principal!;

    const { cursor, limit, status, assignee, tag, q } = parseQuery(listConversationsQuerySchema, req.query);

    // `me` resolves to the verified principal here, not in the query string (ADR-026 §5).
    const filter = toListFilter({ status, assignee, tag }, userId) ?? {};
    // A search is resolved to ids first, then applied to the same paged query (ADR-042 §4).
    if (q !== undefined) filter.matching = await conversationService.resolveSearch(organizationId, q);

    const page = await conversationService.listForOrganization(
      organizationId,
      {
        cursor: decodeConversationCursor(cursor),
        limit,
        filter: Object.keys(filter).length === 0 ? undefined : filter,
      },
      req.log,
    );

    const customers = await customerRepository.findByIdsAndOrganization(
      page.conversations.map((conversation) => conversation.customerId),
      organizationId,
    );

    const assignees = await resolveAssignees(page.conversations, organizationId, role);

    success(res, {
      conversations: page.conversations.map((conversation) =>
        toInboxConversationResponse(
          conversation,
          customers.get(conversation.customerId.toString()) ?? null,
          assigneeFor(conversation, assignees),
        ),
      ),
      nextCursor: page.nextCursor,
    });
  };

  /**
   * Reads one conversation the caller's tenant owns (ADR-025 §5).
   *
   * A conversation that does not exist and one belonging to another
   * organization produce byte-identical 404s (ADR-025 §10) — not because this
   * handler compares them, but because the repository lookup takes both keys
   * and neither matches.
   */
  const readConversation: RequestHandler = async (req, res) => {
    const { organizationId, role } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);

    const conversation = await conversationService.readForOrganization(organizationId, conversationId, req.log);

    const customer = await customerRepository.findByIdAndOrganization(conversation.customerId, organizationId);
    const assignees = await resolveAssignees([conversation], organizationId, role);

    success(res, toInboxConversationResponse(conversation, customer, assigneeFor(conversation, assignees)));
  };

  /** Reads a page of a conversation's history for staff (ADR-025 §5). */
  const listMessages: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);

    const { cursor, limit } = parseQuery(listAgentMessagesQuerySchema, req.query);

    const page = await messageService.listForOrganization(
      organizationId,
      conversationId,
      { cursor, limit },
      req.log,
    );

    success(res, { messages: page.messages.map(toMessageResponse), nextCursor: page.nextCursor });
  };

  /**
   * Sends a reply as the organization (ADR-025 §6).
   *
   * `req.body` is safe to assert: `validateBody(sendAgentMessageSchema)`
   * replaced it with exactly `{ body }`. No `senderType`, no `customerId`, no
   * `conversationId`, and no `organizationId` could have survived that schema
   * even if a client sent them — they are stripped, not rejected, so a forged
   * value never becomes observable to this handler at all.
   *
   * 201, matching `POST /widget/conversations/:id/messages`: a message is
   * created, and `created()` is the envelope helper that exists for that.
   */
  const sendMessage: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);
    const { body, attachmentIds } = req.body as SendAgentMessageInput;

    const message = await messageService.createFromAgent(organizationId, conversationId, body, req.log, attachmentIds);

    created(res, toMessageResponse(message));
  };

  /**
   * Claims or releases a conversation (ADR-026 §2, §4).
   *
   * `req.body` is safe to assert: `validateBody(updateAssignmentSchema)`
   * replaced it with exactly `{ action }`. There is no `assignedTo` and no
   * `userId` in that schema — or in any schema in this codebase — so a client
   * that posted one had it stripped, not rejected, and it never became
   * observable here.
   *
   * The subject of both verbs is `req.principal.userId`, which
   * `requireAccessToken` derived from a verified access token. A client
   * cannot express "assign this to someone else", which is what makes §4's
   * no-stealing rule structural rather than a comparison this handler
   * performs.
   *
   * Answers 200 with the same projection every other read returns, so the
   * client updates its row from the response with no second fetch.
   */
  const updateAssignment: RequestHandler = async (req, res) => {
    const { organizationId, role } = req.organizationContext!;
    const { userId } = req.principal!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);
    const { action } = req.body as UpdateAssignmentInput;

    const conversation =
      action === "claim"
        ? await conversationService.claim(organizationId, conversationId, userId, req.log)
        : await conversationService.release(organizationId, conversationId, userId, req.log);

    const customer = await customerRepository.findByIdAndOrganization(conversation.customerId, organizationId);
    const assignees = await resolveAssignees([conversation], organizationId, role);

    success(res, toInboxConversationResponse(conversation, customer, assigneeFor(conversation, assignees)));
  };

  /**
   * Opens or closes a conversation (ADR-026 §2, §7).
   *
   * Behind `conversation.reply` rather than `conversation.assign` — closing is
   * *acting in* a conversation, which is the standing that permission already
   * describes (ADR-026 §3). That difference is exactly why this is a separate
   * route from `updateAssignment` above: one route names one permission, and a
   * combined `PATCH` would have to check the second one inside a handler.
   *
   * Both transitions are idempotent, and reopening may raise
   * `ConversationReopenConflictError` — the service's translation of ADR-022
   * §3's unique index refusing a second open conversation for one customer.
   * Not caught here: Express 5 forwards a rejected handler promise to the
   * error middleware, which is the single place an error becomes a response.
   */
  const updateStatus: RequestHandler = async (req, res) => {
    const { organizationId, role } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);
    const { status } = req.body as UpdateConversationStatusInput;

    const conversation = await conversationService.setStatus(organizationId, conversationId, status, req.log);

    const customer = await customerRepository.findByIdAndOrganization(conversation.customerId, organizationId);
    const assignees = await resolveAssignees([conversation], organizationId, role);

    success(res, toInboxConversationResponse(conversation, customer, assigneeFor(conversation, assignees)));
  };

  /** Stores one file in an open conversation of the caller's organisation, ready to send (ADR-041 §2). */
  const uploadAttachment: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);

    const attachment = await attachmentService.uploadForAgent(
      organizationId,
      userId,
      conversationId,
      uploadedFileFrom(req),
      req.log,
    );

    created(res, attachment);
  };

  /** Replaces a conversation's tags (ADR-042 §3). */
  const updateTags: RequestHandler = async (req, res) => {
    const { organizationId, role } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);
    const { tags } = req.body as UpdateConversationTagsInput;

    const conversation = await conversationService.setTags(organizationId, conversationId, tags, req.log);
    const customer = await customerRepository.findByIdAndOrganization(conversation.customerId, organizationId);
    const assignees = await resolveAssignees([conversation], organizationId, role);

    success(res, toInboxConversationResponse(conversation, customer, assigneeFor(conversation, assignees)));
  };

  /** Every tag in use in the organisation (ADR-042 §3). */
  const listTags: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    success(res, { tags: await conversationService.listTags(organizationId) });
  };

  return { updateTags, listTags, uploadAttachment, listConversations, readConversation, listMessages, sendMessage, updateAssignment, updateStatus };
}
