import { Schema, model } from "mongoose";
import type { HydratedDocument, Model } from "mongoose";

/**
 * Organization is a Serviqo tenant/workspace — identity and
 * configuration data only. It is not a user, not a membership, and not
 * an authorization object. Per the approved architecture, ownership and
 * role information belong exclusively to the future Membership model
 * (User -> Membership -> Organization) via `Membership{ role: "owner" }`
 * — Organization intentionally carries no ownerUserId or any other
 * authorization pointer, to avoid duplicating a single source of truth.
 *
 * Reserved-slug enforcement (blocking slugs like "api"/"admin"/"login"
 * that might collide with application routes) is deliberately deferred
 * to the future organization-creation service — persistence has no
 * opinion on application routing.
 */
export type OrganizationStatus = "active" | "suspended";

export interface OrganizationAttrs {
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationDocument = HydratedDocument<OrganizationAttrs>;

/**
 * Canonicalizes a slug the same way on write and on read — trim plus
 * lowercase only. Mirrors user.model.ts's normalizeEmail: schema-level
 * lowercase/trim transform values assigned to a document, not query
 * filter objects, so callers building a filter must normalize
 * explicitly (see organization.repository.ts).
 *
 * This does NOT attempt to turn an arbitrary string into a valid slug
 * (stripping spaces/punctuation, generating one from a name, resolving
 * collisions with "-2"/"-3" suffixes). That's exactly the kind of
 * surprising silent transformation persistence should not perform — a
 * malformed slug is rejected by the schema's `match` validator instead.
 * Slug generation from a name is business logic for the future
 * organization-creation/onboarding service, not this layer.
 */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const organizationSchema = new Schema<OrganizationAttrs>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      // Rejects blank/whitespace-only names — trim runs before this
      // validator, so "   " (which trims to "") correctly fails.
      minlength: 1,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: SLUG_PATTERN,
    },
    status: {
      type: String,
      enum: ["active", "suspended"] satisfies OrganizationStatus[],
      default: "active",
    },
  },
  {
    timestamps: true,
  },
);

// Same defense-in-depth serialization boundary as User: internal
// Mongoose bookkeeping never survives serialization.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.__v;
  return ret;
}
organizationSchema.set("toJSON", { transform: stripInternalFields });
organizationSchema.set("toObject", { transform: stripInternalFields });

export const OrganizationModel: Model<OrganizationAttrs> = model<OrganizationAttrs>(
  "Organization",
  organizationSchema,
);
