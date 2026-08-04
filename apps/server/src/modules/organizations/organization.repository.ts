import { OrganizationModel, normalizeSlug } from "./organization.model";
import type { OrganizationDocument } from "./organization.model";

export interface CreateOrganizationInput {
  name: string;
  slug: string;
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
};
