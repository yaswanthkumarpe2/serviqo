import { OrganizationModel, normalizeSlug } from "./organization.model";
import { generateWidgetKey } from "./widgetConfig";

import type { OrganizationDocument } from "./organization.model";
import type { Types } from "mongoose";

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  /**
   * Supplied by the caller rather than generated on insert (ADR-016 §3).
   *
   * The onboarding service writes the owner `Membership` BEFORE the
   * organization, so it needs the id to point that membership at. Generating
   * it here — or letting MongoDB assign it — would force the organization to
   * be written first, which is the one ordering that can leave a tenant
   * nobody owns.
   *
   * Optional, so a caller with no such requirement keeps the ordinary
   * behavior and Mongoose assigns one.
   */
  _id?: Types.ObjectId;
}

/**
 * Organization is the tenant root — this repository is deliberately NOT
 * scoped by another organizationId (contrast with future repositories
 * for resources owned BY an organization — Conversation, Ticket,
 * Customer, etc. — which will be tenant-scoped).
 *
 * MongoDB's unique index on slug is the actual authority against
 * duplicate identities; create() lets a duplicate key error (Mongo code
 * 11000) propagate untouched. Translating that into the API's Conflict
 * error belongs to the future organization-creation service.
 *
 * Deliberately minimal: no listAll/delete/search/findByOwner/findByUser
 * — nothing in the codebase needs them yet.
 */
export const organizationRepository = {
  async create(input: CreateOrganizationInput): Promise<OrganizationDocument> {
    // Passed straight through — the schema's own trim/lowercase transforms
    // normalize on save, and its required/match validators reject missing
    // or malformed fields cleanly. Pre-normalizing here (e.g.
    // input.slug.trim()) would throw a raw TypeError on a missing field
    // instead of a ValidationError.
    return OrganizationModel.create(input);
  },

  async findById(id: string): Promise<OrganizationDocument | null> {
    return OrganizationModel.findById(id);
  },

  async findBySlug(slug: string): Promise<OrganizationDocument | null> {
    return OrganizationModel.findOne({ slug: normalizeSlug(slug) });
  },

  /**
   * Resolves the tenant a public widget request belongs to (ADR-019 §1).
   *
   * THE only way a widget request names an organization. ADR-010 §7 fixed
   * that `organizationId` is "derived server-side from the widget credential,
   * never read from the request body", and this method is what makes that
   * true: an anonymous caller supplies a key, and the server supplies the
   * tenant.
   *
   * The key is passed through unnormalized on purpose. It is a random
   * base64url string, which is case-SENSITIVE — lowercasing it the way
   * `findBySlug` lowercases a slug would silently fail to find three quarters
   * of all keys. There is nothing to canonicalize.
   *
   * Served by the partial unique index on `widgetKey`. A `null` or `undefined`
   * argument cannot reach here through the route (the schema rejects a
   * malformed key first), and would match nothing if it did: the index is
   * partial on `$type: "string"`, and no document stores the key as anything
   * else.
   */
  /**
   * The organization console-invited agents join, until invitations name their
   * organization (ADR-034 §7; ADR-039 replaces this).
   *
   * It served signed-in customers as well until ADR-037 removed customer
   * accounts. The rule is unchanged: the oldest active organization. Oldest rather
   * than newest because it is stable — a deployment's answer to "who does
   * support" must not change the moment somebody creates a second tenant — and
   * `_id` ascending is that order for free, since ObjectIds embed their
   * creation time and are the primary key.
   *
   * `null` when none exists, which is a real state on a fresh deployment.
   */
  async findDefaultOrganization(): Promise<OrganizationDocument | null> {
    return OrganizationModel.findOne({ status: "active" }).sort({ _id: 1 });
  },

  async findByWidgetKey(widgetKey: string): Promise<OrganizationDocument | null> {
    return OrganizationModel.findOne({ widgetKey });
  },

  /**
   * Returns this organization's widget key, minting one first if it has none
   * (ADR-019 §9a, ADR-020 §2).
   *
   * An organization created before Slice 20 has `widgetKey: null` — a
   * correct and inert state until a staff member asks for their embed
   * snippet, which is this call. The mint happens at most once: a fresh
   * key is generated and persisted only when the stored value is still
   * `null`, so every later call (and `findByWidgetKey`) sees the same value.
   */
  async ensureWidgetKey(organizationId: string): Promise<OrganizationDocument | null> {
    const organization = await OrganizationModel.findById(organizationId);
    if (organization === null) return null;

    if (organization.widgetKey === null) {
      organization.widgetKey = generateWidgetKey();
      await organization.save();
    }

    return organization;
  },

  /**
   * Replaces the full allowed-origins list, minting a widget key first if
   * this organization has none (ADR-020 §3, §4).
   *
   * Loads the document and assigns rather than `findByIdAndUpdate`. That
   * distinction is load-bearing here: `allowedOrigins`'s schema-level `set`
   * transform and `validate` function both run when a `Document` is
   * assigned and saved, and an update query does not apply SchemaType
   * setters — writing through one would let two spellings of one origin
   * reach the database uncanonicalized on this one write path while every
   * other path still runs the model's own defence against exactly that.
   */
  async replaceAllowedOrigins(
    organizationId: string,
    allowedOrigins: string[],
  ): Promise<OrganizationDocument | null> {
    const organization = await OrganizationModel.findById(organizationId);
    if (organization === null) return null;

    if (organization.widgetKey === null) {
      organization.widgetKey = generateWidgetKey();
    }
    organization.allowedOrigins = allowedOrigins;
    await organization.save();

    return organization;
  },

  /**
   * Rotates the widget key: mints a new one and overwrites the old one in
   * place (ADR-020 §5).
   *
   * A single stored value rather than a list of currently-valid keys, so
   * "the old key stops working immediately" is not a revocation list to
   * check — `findByWidgetKey` simply cannot find the old value from the
   * moment this `save()` commits, the same way a key-less organization is
   * simply not reachable through the widget (ADR-019 §9a).
   */
  async rotateWidgetKey(organizationId: string): Promise<OrganizationDocument | null> {
    const organization = await OrganizationModel.findById(organizationId);
    if (organization === null) return null;

    organization.widgetKey = generateWidgetKey();
    await organization.save();

    return organization;
  },
};
