import { Schema, model } from "mongoose";
import type { HydratedDocument, Model } from "mongoose";

import { generateWidgetKey, isValidOrigin, normalizeOrigin } from "./widgetConfig";

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
  /**
   * The public identifier for this tenant's chat widget (ADR-019 §9).
   *
   * Nullable, and that is a compatibility decision rather than an optional
   * feature: organizations written before Slice 20 have no key, and nothing
   * about them breaks — widget lookup is BY key, so a key-less organization
   * is simply not reachable through the widget, which is a correct and inert
   * state (ADR-019 §9a).
   */
  widgetKey: string | null;
  /**
   * Websites permitted to embed this tenant's widget, as origins.
   *
   * Empty means CLOSED — no website may embed it — never "any website may".
   * The default is therefore safe (ADR-019 §10).
   */
  allowedOrigins: string[];
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
      /*
        Immutable (ADR-038 §1). The slug IS the organisation's customer chat
        link — `/widget/<slug>` — and that link is printed, bookmarked and
        pasted into places Serviqo never sees. Renaming an organisation changes
        its `name`; it must never silently break every link to it.
      */
      immutable: true,
    },
    status: {
      type: String,
      enum: ["active", "suspended"] satisfies OrganizationStatus[],
      default: "active",
    },
    /*
      Minted in persistence rather than by the onboarding service, which is
      where `slug` is generated — and the difference is the point (ADR-019 §9).

      A slug needs collision retry and reserved-word policy. That is business
      logic, and this file's header says persistence has no opinion on
      application routing. A widget key needs neither: 256 bits of entropy
      makes the retry branch one that never executes, and there are no
      reserved keys. It is an identifier in exactly the sense `_id` is.

      What this buys is an invariant rather than a convention: every
      organization created from now on has a key, through every creation path
      including tests and future admin tooling, with nothing to remember.

      The default here is `null`, NOT the generator, and that is deliberate —
      see the `pre("save")` hook below for the trap it avoids.

      Not `select: false`. The value is designed to be public — it appears in
      the tenant's own page source — so hiding it from queries would imply a
      secrecy it does not have. What matters is that no response in this slice
      includes it, which each controller decides explicitly.
    */
    widgetKey: {
      type: String,
      default: null,
    },
    /*
      Validated per entry rather than trusted. `isValidOrigin` rejects
      wildcards, non-http(s) schemes, and anything carrying a path, query,
      fragment, or userinfo — a URL stored where an origin belongs produces a
      rule that can never match, which is a silently dead security control.

      The setter canonicalizes on assignment, the same instrument `slug` and
      `email` use for `lowercase`/`trim`. `URL.origin` lowercases the scheme
      and host and drops a default port, so one origin cannot be stored twice
      in two spellings.
    */
    allowedOrigins: {
      type: [String],
      default: [],
      set: (origins: string[]) =>
        Array.isArray(origins) ? origins.map((origin) => normalizeOrigin(origin) ?? origin) : origins,
      validate: {
        validator: (origins: string[]) => origins.every(isValidOrigin),
        message: "allowedOrigins must contain only http(s) origins, without paths or wildcards",
      },
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Mints a widget key for a NEW organization, and only for a new one.
 *
 * A hook rather than `default: generateWidgetKey`, because Mongoose applies
 * schema defaults when HYDRATING a document too, not only when creating one.
 * With the generator as the default, every read of a pre-Slice-20
 * organization would have materialized a fresh random key in memory — a
 * different one on every read, none of them persisted. That is a trap rather
 * than a convenience: the installation surface would show a staff member a
 * key, they would embed it on their website, and nothing would ever find it,
 * because `findByWidgetKey` queries the database and the database has no such
 * value (ADR-019 §9a).
 *
 * `default: null` above makes hydration deterministic — a key-less
 * organization reads back as `null`, every time — and this hook makes the
 * invariant hold where it matters. A key supplied explicitly by the caller is
 * left alone, so a test or a future re-key can set one.
 */
organizationSchema.pre("save", function assignWidgetKey() {
  if (this.isNew && (this.widgetKey === null || this.widgetKey === undefined)) {
    this.widgetKey = generateWidgetKey();
  }
});

/**
 * Unique among the organizations that HAVE a key, and partial for a reason
 * that would otherwise have broken every existing deployment (ADR-019 §9a).
 *
 * MongoDB indexes a missing field as `null`, so a plain `unique: true` would
 * treat every pre-Slice-20 organization as colliding with every other one on
 * the value `null` — the index build itself fails on any database holding two
 * of them, and no second key-less organization could ever be written.
 *
 * `$type: "string"` constrains only documents that actually carry one. Same
 * instrument `membership.model.ts` index B used for "at most one owner",
 * applied here to mean "unique among those that exist".
 *
 * It also serves `findByWidgetKey`, which is the only way a widget request
 * resolves its tenant — an unindexed lookup there would be a collection scan
 * on an unauthenticated public endpoint.
 */
organizationSchema.index(
  { widgetKey: 1 },
  { unique: true, partialFilterExpression: { widgetKey: { $type: "string" } } },
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
