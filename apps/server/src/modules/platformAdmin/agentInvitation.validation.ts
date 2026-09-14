import { z } from "zod";

/**
 * What an admin may send when adding an agent (ADR-034 §7).
 *
 * Two fields, and the omissions are the design. There is no `password`,
 * because the server generates it and an admin-chosen password would be a
 * credential known to two people. There is no `organizationId`, because the
 * tenant is derived. There is no `role`, because an invited agent is an agent
 * — promoting one is a different action with a different audit story. There is
 * no `status` and no `emailVerifiedAt`, because an admin who could send those
 * could mint a verified account for an address they do not control, which is
 * the entire thing verification exists to prevent.
 *
 * `.strict()` so a body carrying any of the above is REFUSED rather than
 * silently stripped. A request that tried is worth a 400: it means a client is
 * attempting something the API deliberately does not offer.
 */
export const inviteAgentSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
    /*
      Zod's email check, then trim+lowercase, matching `auth.validation.ts`.
      Canonicalizing here means the uniqueness index sees the same form the
      lookup will, so "already exists" cannot depend on how somebody typed it.
    */
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Email is required")
      .max(254, "Email is too long")
      .email("Enter a valid email address"),
  })
  .strict();

export type InviteAgentInput = z.infer<typeof inviteAgentSchema>;
