import { z } from "zod";

/**
 * Request schemas for the super admin's organisation controls (ADR-039).
 */

const CONTROL_CHARACTERS = /\p{Cc}/u;

const nameField = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), `${label} must not contain control characters`);

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .max(254, "Email is too long")
  .pipe(z.email("Enter a valid email address"));

/** A new organisation and the person who will own it. */
export const createOrganizationWithOwnerSchema = z
  .object({
    name: nameField("Organisation name", 100),
    owner: z.object({ name: nameField("Owner name", 120), email: emailField }).strict(),
  })
  .strict();

export type CreateOrganizationWithOwnerInput = z.infer<typeof createOrganizationWithOwnerSchema>;

export const updateOrganizationStatusSchema = z.object({ status: z.enum(["active", "suspended"]) }).strict();

export type UpdateOrganizationStatusInput = z.infer<typeof updateOrganizationStatusSchema>;

/** Any role, including `owner` for an organisation that has none. */
export const inviteOrganizationMemberSchema = z
  .object({
    name: nameField("Name", 120),
    email: emailField,
    role: z.enum(["owner", "admin", "supervisor", "agent"]),
  })
  .strict();

export type InviteOrganizationMemberInput = z.infer<typeof inviteOrganizationMemberSchema>;
