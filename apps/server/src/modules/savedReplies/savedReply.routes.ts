import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";

import { MESSAGE_BODY_MAX_LENGTH, SAVED_REPLIES_PER_ORGANIZATION } from "../../config/constants";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors";
import { created, noContent, success } from "../../lib/response";
import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { SAVED_REPLY_SHORTCUT_PATTERN, SavedReplyModel } from "./savedReply.model";

import type { RateLimiters } from "../../lib/rateLimit";
import type { SavedReplyDocument } from "./savedReply.model";
import type { RequestHandler } from "express";

/**
 * Saved replies (ADR-042 §1).
 *
 *   GET    /organizations/:orgId/saved-replies        conversation.read
 *   POST   /organizations/:orgId/saved-replies        saved_reply.manage
 *   PATCH  /organizations/:orgId/saved-replies/:id    saved_reply.manage
 *   DELETE /organizations/:orgId/saved-replies/:id    saved_reply.manage
 *
 * Every agent can USE them; owners, admins and supervisors decide what the
 * team's answers say. Every query carries the organisation id with the reply
 * id, so an id from another organisation finds nothing.
 */

export class SavedReplyShortcutTakenError extends AppError {
  readonly httpStatus = 409;
  readonly code = "SAVED_REPLY_SHORTCUT_TAKEN";
}

export class SavedReplyLimitReachedError extends AppError {
  readonly httpStatus = 422;
  readonly code = "SAVED_REPLY_LIMIT_REACHED";
}

const shortcutSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SAVED_REPLY_SHORTCUT_PATTERN, "shortcut must be 1–32 lowercase letters, digits, - or _");

export const createSavedReplySchema = z.object({
  shortcut: shortcutSchema,
  title: z.string().trim().min(1, "title is required").max(80, "title must be at most 80 characters"),
  body: z
    .string()
    .trim()
    .min(1, "body is required")
    .max(MESSAGE_BODY_MAX_LENGTH, `body must be at most ${MESSAGE_BODY_MAX_LENGTH} characters`),
});

export const updateSavedReplySchema = createSavedReplySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

export function toSavedReplyResponse(reply: SavedReplyDocument) {
  return {
    id: reply._id.toString(),
    shortcut: reply.shortcut,
    title: reply.title,
    body: reply.body,
    updatedAt: reply.updatedAt,
  };
}

const DUPLICATE_KEY_ERROR = 11000;
const isDuplicateKey = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY_ERROR;

const SHORTCUT_TAKEN = "Another saved reply already uses that shortcut";

function requireReplyId(value: unknown): string {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) {
    throw new ValidationError("Request validation failed", [{ field: "savedReplyId", message: "savedReplyId is not a valid id" }]);
  }
  return value;
}

export function createSavedReplyRouter({ rateLimiters }: { rateLimiters: RateLimiters }): Router {
  const router = Router({ mergeParams: true });

  const list: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const replies = await SavedReplyModel.find({ organizationId }).sort({ shortcut: 1 });
    success(res, { savedReplies: replies.map(toSavedReplyResponse) });
  };

  const create: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;
    const input = req.body as z.infer<typeof createSavedReplySchema>;

    if ((await SavedReplyModel.countDocuments({ organizationId })) >= SAVED_REPLIES_PER_ORGANIZATION) {
      throw new SavedReplyLimitReachedError(`An organisation can keep at most ${SAVED_REPLIES_PER_ORGANIZATION} saved replies`);
    }

    try {
      const reply = await SavedReplyModel.create({ ...input, organizationId, createdByUserId: userId });
      req.log.info({ event: "saved_reply.created", organizationId, savedReplyId: reply._id.toString() }, "Saved reply created");
      created(res, toSavedReplyResponse(reply));
    } catch (err) {
      if (isDuplicateKey(err)) throw new SavedReplyShortcutTakenError(SHORTCUT_TAKEN);
      throw err;
    }
  };

  const update: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const savedReplyId = requireReplyId(req.params.savedReplyId);
    const input = req.body as z.infer<typeof updateSavedReplySchema>;

    try {
      const reply = await SavedReplyModel.findOneAndUpdate(
        { _id: savedReplyId, organizationId },
        { $set: input },
        { returnDocument: "after", runValidators: true },
      );
      if (reply === null) throw new NotFoundError("Saved reply not found");
      req.log.info({ event: "saved_reply.updated", organizationId, savedReplyId }, "Saved reply updated");
      success(res, toSavedReplyResponse(reply));
    } catch (err) {
      if (isDuplicateKey(err)) throw new SavedReplyShortcutTakenError(SHORTCUT_TAKEN);
      throw err;
    }
  };

  const remove: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const savedReplyId = requireReplyId(req.params.savedReplyId);

    const { deletedCount } = await SavedReplyModel.deleteOne({ _id: savedReplyId, organizationId });
    if (deletedCount === 0) throw new NotFoundError("Saved reply not found");
    req.log.info({ event: "saved_reply.deleted", organizationId, savedReplyId }, "Saved reply deleted");
    noContent(res);
  };

  router.get("/", requireAccessToken, rateLimiters.authenticatedRead, requireOrganization, requirePermission("conversation.read"), list);
  router.post(
    "/",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("saved_reply.manage"),
    validateBody(createSavedReplySchema),
    create,
  );
  router.patch(
    "/:savedReplyId",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("saved_reply.manage"),
    validateBody(updateSavedReplySchema),
    update,
  );
  router.delete(
    "/:savedReplyId",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("saved_reply.manage"),
    remove,
  );

  return router;
}
