import { EventEmitter } from "node:events";

import { Router } from "express";
import mongoose, { Types } from "mongoose";
import { z } from "zod";

import { AppError, ValidationError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { success } from "../../lib/response";
import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { toConversationUpdatedEvent, conversationEvents } from "../conversations/conversationEvents";
import { ConversationModel } from "../conversations/conversation.model";
import { CustomerModel } from "../customers/customer.model";
import { MessageModel } from "../messages/message.model";
import { userRepository } from "../users/user.repository";
import { OBJECT_ID_PATTERN } from "../widget/widgetConversation.validation";

import type { RateLimiters } from "../../lib/rateLimit";
import type { CustomerDocument } from "../customers/customer.model";
import type { RequestHandler } from "express";

/**
 * Customer profiles (ADR-043).
 *
 *   GET    /organizations/:orgId/customers?q=                 conversation.read   find a contact
 *   GET    /organizations/:orgId/customers/:id                conversation.read   the profile
 *   PATCH  /organizations/:orgId/customers/:id                conversation.reply  edit details and note
 *   POST   /organizations/:orgId/customers/:id/block          customer.manage     block
 *   DELETE /organizations/:orgId/customers/:id/block          customer.manage     unblock
 *   POST   /organizations/:orgId/customers/:id/merge          customer.manage     merge a duplicate in
 *
 * Every query carries the organisation id with the customer id: a customer of
 * another organisation is the same 404 as one that does not exist.
 */

export class CustomerNotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}

export class CustomerMergeConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = "CUSTOMER_MERGE_CONFLICT";
}

const NAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;
const PROFILE_NOTE_MAX_LENGTH = 2000;
const PHONE_PATTERN = /^\+?[0-9 ().-]{5,32}$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const PROFILE_CONVERSATIONS = 20;
const SEARCH_RESULTS = 10;

/** `null` or an empty string clears a field; absent leaves it alone. */
const clearable = <T extends z.ZodType<string>>(schema: T) =>
  z.union([z.literal(null), z.literal("").transform(() => null), schema]).optional();

export const updateCustomerSchema = z
  .object({
    name: clearable(
      z
        .string()
        .trim()
        .min(1)
        .max(NAME_MAX_LENGTH, `name must be at most ${NAME_MAX_LENGTH} characters`)
        .refine((value) => !CONTROL_CHARACTERS.test(value), "name must not contain control characters"),
    ),
    email: clearable(
      z
        .string()
        .trim()
        .max(EMAIL_MAX_LENGTH)
        .pipe(z.email("email must be a valid email address"))
        .transform((value) => value.toLowerCase()),
    ),
    phone: clearable(z.string().trim().regex(PHONE_PATTERN, "phone must be a phone number")),
    profileNote: clearable(
      z.string().trim().max(PROFILE_NOTE_MAX_LENGTH, `profileNote must be at most ${PROFILE_NOTE_MAX_LENGTH} characters`),
    ),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Nothing to update");

export const mergeCustomerSchema = z.object({
  sourceCustomerId: z.string().regex(OBJECT_ID_PATTERN, "sourceCustomerId is not a valid id"),
});

// ---- events: staff see profile changes live; blocked and merged visitors lose their sockets ----

export type CustomerEvent =
  | { type: "updated"; organizationId: string; customer: ReturnType<typeof toContactResponse> }
  | { type: "access_revoked"; organizationId: string; customerId: string; reason: "blocked" | "merged" }
  | { type: "merged"; organizationId: string; sourceCustomerId: string; customer: ReturnType<typeof toContactResponse> };

const CUSTOMER_EVENT = "customer.event";
const emitter = new EventEmitter();

export const customerEvents = {
  subscribe(listener: (event: CustomerEvent) => void): () => void {
    emitter.on(CUSTOMER_EVENT, listener);
    return () => {
      emitter.off(CUSTOMER_EVENT, listener);
    };
  },
  publish(event: CustomerEvent): void {
    try {
      emitter.emit(CUSTOMER_EVENT, event);
    } catch (err) {
      logger.error(
        { event: "customer.broadcast_failed", organizationId: event.organizationId, err: err instanceof Error ? err.name : "UnknownError" },
        "A customer event subscriber threw",
      );
    }
  },
};

// ---- projections ----

/** What a row in the inbox knows about a customer. */
export function toContactResponse(customer: CustomerDocument) {
  return {
    id: customer._id.toString(),
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    blocked: customer.blockedAt !== null && customer.blockedAt !== undefined,
  };
}

async function toProfileResponse(customer: CustomerDocument) {
  const conversations = await ConversationModel.find({ organizationId: customer.organizationId, customerId: customer._id })
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(PROFILE_CONVERSATIONS);
  const blockedBy =
    customer.blockedByUserId === null || customer.blockedByUserId === undefined
      ? null
      : ((await userRepository.findByIds([customer.blockedByUserId])).get(customer.blockedByUserId.toString()) ?? null);

  return {
    ...toContactResponse(customer),
    profileNote: customer.profileNote ?? null,
    createdAt: customer.createdAt,
    lastSeenAt: customer.lastSeenAt,
    blockedAt: customer.blockedAt ?? null,
    blockedBy: blockedBy === null ? null : { id: blockedBy._id.toString(), name: blockedBy.name },
    conversations: conversations.map((conversation) => ({
      id: conversation._id.toString(),
      status: conversation.status,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
      tags: conversation.tags ?? [],
    })),
  };
}

// ---- helpers ----

function requireCustomerId(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw new ValidationError("Request validation failed", [{ field: "customerId", message: "customerId is not a valid id" }]);
  }
  return value;
}

/** A live customer of this organisation: not merged away into another. */
async function requireCustomer(organizationId: string, customerId: string): Promise<CustomerDocument> {
  const customer = await CustomerModel.findOne({ _id: customerId, organizationId, mergedIntoCustomerId: null });
  if (customer === null) throw new CustomerNotFoundError("Customer not found");
  return customer;
}

let transactionSupport: Promise<boolean> | null = null;

/** Whether the connected deployment can run a transaction, asked once per process. */
function supportsTransactions(): Promise<boolean> {
  transactionSupport ??= (async () => {
    try {
      const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
      return typeof hello.setName === "string" || hello.msg === "isdbgrid";
    } catch {
      return false;
    }
  })();
  return transactionSupport;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Closes a customer's open conversations and tells the team, as a block does. */
async function closeOpenConversations(organizationId: string, customerId: Types.ObjectId): Promise<number> {
  const open = await ConversationModel.find({ organizationId, customerId, status: "open" });
  for (const conversation of open) {
    const closed = await ConversationModel.findOneAndUpdate(
      { _id: conversation._id, organizationId },
      { $set: { status: "closed" } },
      { returnDocument: "after" },
    );
    if (closed !== null) conversationEvents.publish(toConversationUpdatedEvent(organizationId, closed));
  }
  return open.length;
}

export function createCustomerProfileRouter({ rateLimiters }: { rateLimiters: RateLimiters }): Router {
  const router = Router({ mergeParams: true });

  const search: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2 || q.length > 100) {
      throw new ValidationError("Request validation failed", [{ field: "q", message: "q must be 2–100 characters" }]);
    }
    const pattern = new RegExp(escapeRegex(q), "i");
    const customers = await CustomerModel.find({
      organizationId,
      mergedIntoCustomerId: null,
      $or: [{ name: pattern }, { email: pattern }, { phone: pattern }],
    })
      .sort({ lastSeenAt: -1 })
      .limit(SEARCH_RESULTS);

    success(res, { customers: customers.map((customer) => ({ ...toContactResponse(customer), lastSeenAt: customer.lastSeenAt })) });
  };

  const read: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const customer = await requireCustomer(organizationId, requireCustomerId(req.params.customerId));
    success(res, await toProfileResponse(customer));
  };

  const update: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const customerId = requireCustomerId(req.params.customerId);
    const input = req.body as z.infer<typeof updateCustomerSchema>;

    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) if (value !== undefined) set[key] = value;

    const customer = await CustomerModel.findOneAndUpdate(
      { _id: customerId, organizationId, mergedIntoCustomerId: null },
      { $set: set },
      { returnDocument: "after" },
    );
    if (customer === null) throw new CustomerNotFoundError("Customer not found");

    // Which fields changed, never their values: they are a person's details.
    req.log.info({ event: "customer.updated", organizationId, customerId, fields: Object.keys(set) }, "Customer details edited");
    customerEvents.publish({ type: "updated", organizationId, customer: toContactResponse(customer) });
    success(res, await toProfileResponse(customer));
  };

  const block: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;
    const customerId = requireCustomerId(req.params.customerId);
    await requireCustomer(organizationId, customerId);

    const customer = await CustomerModel.findOneAndUpdate(
      { _id: customerId, organizationId },
      { $set: { blockedAt: new Date(), blockedByUserId: userId } },
      { returnDocument: "after" },
    );
    const closed = await closeOpenConversations(organizationId, customer!._id);

    req.log.info({ event: "customer.blocked", organizationId, customerId, closedConversations: closed }, "Customer blocked");
    customerEvents.publish({ type: "access_revoked", organizationId, customerId, reason: "blocked" });
    customerEvents.publish({ type: "updated", organizationId, customer: toContactResponse(customer!) });
    success(res, await toProfileResponse(customer!));
  };

  const unblock: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const customerId = requireCustomerId(req.params.customerId);
    await requireCustomer(organizationId, customerId);

    const customer = await CustomerModel.findOneAndUpdate(
      { _id: customerId, organizationId },
      { $set: { blockedAt: null, blockedByUserId: null } },
      { returnDocument: "after" },
    );

    req.log.info({ event: "customer.unblocked", organizationId, customerId }, "Customer unblocked");
    customerEvents.publish({ type: "updated", organizationId, customer: toContactResponse(customer!) });
    success(res, await toProfileResponse(customer!));
  };

  /**
   * Merges a duplicate (the source) into this customer (the target).
   *
   * The source's conversations and messages move to the target; the target
   * keeps its own details and fills any it lacks from the source. The source
   * record stays as a pointer (`mergedIntoCustomerId`), so the visitor on the
   * source's device resumes as the target next time (ADR-043 §4).
   *
   * Refused when both have an open conversation: one customer may have only
   * one open conversation, and choosing which to close is the agent's call.
   */
  const merge: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const targetId = requireCustomerId(req.params.customerId);
    const { sourceCustomerId } = req.body as z.infer<typeof mergeCustomerSchema>;

    if (sourceCustomerId === targetId) {
      throw new ValidationError("Request validation failed", [{ field: "sourceCustomerId", message: "A customer cannot be merged into itself" }]);
    }

    const [target, source] = await Promise.all([
      requireCustomer(organizationId, targetId),
      requireCustomer(organizationId, sourceCustomerId),
    ]);

    const [targetOpen, sourceOpen] = await Promise.all([
      ConversationModel.exists({ organizationId, customerId: target._id, status: "open" }),
      ConversationModel.exists({ organizationId, customerId: source._id, status: "open" }),
    ]);
    if (targetOpen !== null && sourceOpen !== null) {
      throw new CustomerMergeConflictError("Both customers have an open conversation. Close one before merging.");
    }

    const orgId = new Types.ObjectId(organizationId);
    const run = async (session?: mongoose.ClientSession) => {
      // Native updates: `customerId` is immutable to Mongoose on purpose, and a merge is the one sanctioned rewrite.
      await ConversationModel.collection.updateMany(
        { organizationId: orgId, customerId: source._id },
        { $set: { customerId: target._id } },
        { session },
      );
      await MessageModel.collection.updateMany(
        { organizationId: orgId, customerId: source._id },
        { $set: { customerId: target._id } },
        { session },
      );
      const fill: Record<string, unknown> = {};
      if (target.name === null && source.name !== null) fill.name = source.name;
      if (target.email === null && source.email !== null) fill.email = source.email;
      if (target.phone === null && source.phone !== null) fill.phone = source.phone;
      if ((target.profileNote ?? null) === null && (source.profileNote ?? null) !== null) fill.profileNote = source.profileNote;
      if (source.blockedAt !== null && target.blockedAt === null) {
        fill.blockedAt = source.blockedAt;
        fill.blockedByUserId = source.blockedByUserId;
      }
      if (Object.keys(fill).length > 0) {
        await CustomerModel.collection.updateOne({ _id: target._id, organizationId: orgId }, { $set: fill }, { session });
      }
      await CustomerModel.collection.updateOne(
        { _id: source._id, organizationId: orgId },
        { $set: { mergedIntoCustomerId: target._id, mergedAt: new Date() } },
        { session },
      );
    };

    /*
      In a transaction where the deployment supports one (a replica set or
      sharded cluster, as Atlas is). A standalone server cannot, and there the
      steps run in order: each is idempotent, so a merge interrupted halfway is
      completed by running it again.
    */
    if (await supportsTransactions()) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(() => run(session));
      } finally {
        await session.endSession();
      }
    } else {
      await run();
    }

    const merged = (await CustomerModel.findOne({ _id: target._id, organizationId }))!;
    req.log.info({ event: "customer.merged", organizationId, targetCustomerId: targetId, sourceCustomerId }, "Customers merged");
    customerEvents.publish({ type: "access_revoked", organizationId, customerId: sourceCustomerId, reason: "merged" });
    customerEvents.publish({ type: "merged", organizationId, sourceCustomerId, customer: toContactResponse(merged) });
    success(res, await toProfileResponse(merged));
  };

  const read_ = [requireAccessToken, rateLimiters.authenticatedRead, requireOrganization, requirePermission("conversation.read")];
  router.get("/", ...read_, search);
  router.get("/:customerId", ...read_, read);
  router.patch(
    "/:customerId",
    requireAccessToken,
    rateLimiters.agentConversationWrite,
    requireOrganization,
    requirePermission("conversation.reply"),
    validateBody(updateCustomerSchema),
    update,
  );
  const manage = [requireAccessToken, rateLimiters.authenticatedWrite, requireOrganization, requirePermission("customer.manage")];
  router.post("/:customerId/block", ...manage, block);
  router.delete("/:customerId/block", ...manage, unblock);
  router.post("/:customerId/merge", ...manage, validateBody(mergeCustomerSchema), merge);

  return router;
}
