import { EventEmitter } from "node:events";

import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";

import { MESSAGE_BODY_MAX_LENGTH, NOTE_MENTIONS_MAX, NOTES_PER_CONVERSATION_READ_MAX } from "../../config/constants";
import { ConversationNotAccessibleError, ValidationError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { created, success } from "../../lib/response";
import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { conversationRepository } from "../conversations/conversation.repository";
import { membershipRepository } from "../memberships/membership.repository";
import { userRepository } from "../users/user.repository";
import { OBJECT_ID_PATTERN } from "../widget/widgetConversation.validation";
import { NoteModel } from "./note.model";

import type { RateLimiters } from "../../lib/rateLimit";
import type { NoteDocument } from "./note.model";
import type { RequestHandler } from "express";

/**
 * Internal notes (ADR-042 §2).
 *
 *   GET  /organizations/:orgId/conversations/:conversationId/notes   conversation.read
 *   POST /organizations/:orgId/conversations/:conversationId/notes   conversation.reply
 *
 * Staff-only by construction: notes are their own collection, and the only
 * broadcast is `note:new` to the organisation's inbox room, which no widget
 * socket can join.
 */

export const createNoteSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "body is required")
    .max(MESSAGE_BODY_MAX_LENGTH, `body must be at most ${MESSAGE_BODY_MAX_LENGTH} characters`),
  mentionedUserIds: z
    .array(z.string().regex(OBJECT_ID_PATTERN, "mentionedUserIds must be user ids"))
    .max(NOTE_MENTIONS_MAX, `at most ${NOTE_MENTIONS_MAX} mentions`)
    .default([]),
});

export interface NoteResponse {
  id: string;
  conversationId: string;
  author: { id: string; name: string | null };
  body: string;
  mentions: { id: string; name: string | null }[];
  createdAt: Date;
}

async function toNoteResponses(notes: NoteDocument[]): Promise<NoteResponse[]> {
  const userIds = [...new Set(notes.flatMap((note) => [note.authorUserId, ...note.mentionedUserIds].map(String)))];
  const users = await userRepository.findByIds(userIds);
  const person = (id: Types.ObjectId) => ({ id: id.toString(), name: users.get(id.toString())?.name ?? null });

  return notes.map((note) => ({
    id: note._id.toString(),
    conversationId: note.conversationId.toString(),
    author: person(note.authorUserId),
    body: note.body,
    mentions: note.mentionedUserIds.map(person),
    createdAt: note.createdAt,
  }));
}

// ---- the domain event seam, mirroring messageEvents (ADR-025 §2) ----

export interface NoteCreatedEvent {
  organizationId: string;
  conversationId: string;
  note: NoteResponse;
}

const NOTE_CREATED = "note.created";
const emitter = new EventEmitter();

export const noteEvents = {
  subscribe(listener: (event: NoteCreatedEvent) => void): () => void {
    emitter.on(NOTE_CREATED, listener);
    return () => {
      emitter.off(NOTE_CREATED, listener);
    };
  },
  publish(event: NoteCreatedEvent): void {
    try {
      emitter.emit(NOTE_CREATED, event);
    } catch (err) {
      logger.error(
        { event: "note.broadcast_failed", organizationId: event.organizationId, err: err instanceof Error ? err.name : "UnknownError" },
        "A note.created subscriber threw",
      );
    }
  },
};

function requireConversationId(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw new ValidationError("Request validation failed", [{ field: "conversationId", message: "conversationId is not a valid id" }]);
  }
  return value;
}

async function requireTenantConversation(organizationId: string, conversationId: string) {
  const conversation = await conversationRepository.findByIdForOrganization(conversationId, organizationId);
  if (conversation === null) throw new ConversationNotAccessibleError("Conversation not found");
  return conversation;
}

export function createNoteRouter({ rateLimiters }: { rateLimiters: RateLimiters }): Router {
  const router = Router({ mergeParams: true });

  const list: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const conversationId = requireConversationId(req.params.conversationId);
    await requireTenantConversation(organizationId, conversationId);

    const notes = await NoteModel.find({ organizationId, conversationId })
      .sort({ _id: 1 })
      .limit(NOTES_PER_CONVERSATION_READ_MAX);

    success(res, { notes: await toNoteResponses(notes) });
  };

  const create: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;
    const conversationId = requireConversationId(req.params.conversationId);
    const { body, mentionedUserIds } = req.body as z.infer<typeof createNoteSchema>;

    await requireTenantConversation(organizationId, conversationId);

    /*
      Only ACTIVE members of this organisation can be mentioned. Anyone else
      named is dropped rather than refused: the note is still worth saving, and
      a refusal would tell the author whether an arbitrary user id is on the team.
    */
    const members = await membershipRepository.findActiveByOrganizationAndUsers(organizationId, [
      ...new Set(mentionedUserIds),
    ]);

    const note = await NoteModel.create({
      organizationId,
      conversationId,
      authorUserId: userId,
      body,
      mentionedUserIds: [...members.keys()].map((id) => new Types.ObjectId(id)),
    });

    const [response] = await toNoteResponses([note]);

    // No body in the log: notes are staff-authored content about a customer.
    req.log.info(
      { event: "note.created", organizationId, conversationId, noteId: response!.id, mentions: response!.mentions.length },
      "Internal note created",
    );

    noteEvents.publish({ organizationId, conversationId, note: response! });
    created(res, response);
  };

  router.get(
    "/",
    requireAccessToken,
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("conversation.read"),
    list,
  );
  router.post(
    "/",
    requireAccessToken,
    rateLimiters.agentConversationWrite,
    requireOrganization,
    requirePermission("conversation.reply"),
    validateBody(createNoteSchema),
    create,
  );

  return router;
}

/**
 * `GET /organizations/:orgId/teammates` (ADR-042 §2): the active members'
 * ids and names, for the @mention picker and for showing who wrote a note.
 *
 * Names only — never an email, role or status — behind `conversation.read`,
 * because working a shared inbox means knowing who your colleagues are.
 * The full roster stays behind `member.read`.
 */
export function createTeammatesRouter({ rateLimiters }: { rateLimiters: RateLimiters }): Router {
  const router = Router({ mergeParams: true });

  router.get(
    "/",
    requireAccessToken,
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("conversation.read"),
    async (req, res) => {
      const { organizationId } = req.organizationContext!;
      const memberships = await membershipRepository.listForOrganization(organizationId);
      const active = memberships.filter((membership) => membership.status === "active");
      const users = await userRepository.findByIds(active.map((membership) => membership.userId));

      success(res, {
        teammates: active
          .map((membership) => ({ id: membership.userId.toString(), name: users.get(membership.userId.toString())?.name ?? null }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      });
    },
  );

  return router;
}
