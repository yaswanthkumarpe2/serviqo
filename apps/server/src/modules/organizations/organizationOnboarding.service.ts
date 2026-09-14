import { Types } from "mongoose";

import { InvalidAccessTokenError, OrganizationSlugUnavailableError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { failureType } from "../auth/authLogging";
import { membershipRepository } from "../memberships/membership.repository";
import { userRepository } from "../users/user.repository";
import { organizationRepository } from "./organization.repository";
import { isReservedSlug, isWellFormedSlug, slugCandidate, slugifyOrganizationName } from "./organizationSlug";

import type { AuthLogger } from "../auth/authLogging";
import type { MembershipRole } from "../memberships/membership.model";
import type { OrganizationDocument } from "./organization.model";
import type { CreateOrganizationInput } from "./organization.validation";

/**
 * Organization onboarding (ADR-016) — the operation that brings Serviqo's
 * first tenant, and its first RBAC subject, into existence.
 *
 * `AuthLogger` and `failureType` are imported from the auth module rather
 * than duplicated. The name is now slightly wrong for a cross-domain
 * utility; per ADR-016 §9 the pair moves to `lib/` when a third domain needs
 * it, and renaming it today would churn nine auth files.
 */

/** What the caller learns about the tenant they just created. */
export interface CreatedOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
}

export interface OrganizationOnboardingResult {
  organization: CreatedOrganization;
  /**
   * The caller's role in what they just created — always `"owner"`.
   *
   * Included because it is the one fact the client cannot derive: it has
   * created something and is now the owner of it. Typed as `MembershipRole`
   * rather than the literal, so this cannot silently become the place a
   * second role appears.
   */
  role: MembershipRole;
}

/** Who is creating. Comes from the verified access token, never from the body. */
export interface OnboardingActor {
  userId: string;
}

export interface OrganizationOnboardingService {
  createOrganization(
    input: CreateOrganizationInput,
    actor: OnboardingActor,
    log?: AuthLogger,
  ): Promise<OrganizationOnboardingResult>;
}

/**
 * How many slug candidates to try before giving up (ADR-016 §7).
 *
 * Bounded rather than looping: an unbounded retry against a contended name is
 * a request that never returns. Twenty is far past the point where a human
 * would rather pick a different name.
 */
const MAX_SLUG_ATTEMPTS = 20;

/** MongoDB's duplicate-key error code — the unique index rejecting a write. */
const DUPLICATE_KEY_ERROR = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY_ERROR;
}

function toCreatedOrganization(organization: OrganizationDocument): CreatedOrganization {
  return {
    id: organization._id.toString(),
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    createdAt: organization.createdAt,
  };
}

/**
 * Writes the organization under the first slug the database accepts.
 *
 * The availability read is a fast pre-check and deliberately NOT the
 * authority: two concurrent requests can both find `acme-2` free, and the
 * unique index rejects one of them. That request advances to the next
 * candidate rather than failing — the pattern `registration.service.ts`
 * established for email, where "the unique index is the final authority"
 * catches the race the pre-check cannot (ADR-016 §7).
 */
export async function createWithAvailableSlug(
  organizationId: Types.ObjectId,
  name: string,
  log: AuthLogger,
): Promise<OrganizationDocument> {
  const base = slugifyOrganizationName(name);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = slugCandidate(base, attempt);

    /*
      Reserved and taken are one condition with one resolution (ADR-016 §6),
      so an organization named "Admin" receives `admin-2` rather than an
      error: the tenant's name is legitimate, only the URL segment is
      spoken for.
    */
    if (isReservedSlug(slug)) continue;

    /*
      Guards the generator against its own output. The schema validates
      `slug` with the same pattern, so a disagreement here would surface as
      a Mongoose ValidationError from persistence — a 500 on a perfectly
      valid name. Skipping rather than throwing keeps one malformed
      candidate from ending an otherwise fine request.
    */
    if (!isWellFormedSlug(slug)) continue;

    if (await organizationRepository.findBySlug(slug)) continue;

    try {
      return await organizationRepository.create({ _id: organizationId, name, slug });
    } catch (err) {
      // Lost the race to a concurrent request; the next candidate is free
      // to try. Any other failure is not ours to reinterpret.
      if (isDuplicateKeyError(err)) continue;
      throw err;
    }
  }

  /*
    The base is logged and the name is not. A slugified base is already a
    public URL segment; the name it came from is tenant content
    (ADR-016 §9).
  */
  log.info(
    { event: "organization.slug_exhausted", organizationId: organizationId.toString(), base, attempts: MAX_SLUG_ATTEMPTS },
    "Every candidate slug for this name was reserved or taken",
  );
  throw new OrganizationSlugUnavailableError(
    "Could not derive an available address for that organization name. Try a different name.",
  );
}

export function createOrganizationOnboardingService(): OrganizationOnboardingService {
  return {
    async createOrganization(
      input: CreateOrganizationInput,
      actor: OnboardingActor,
      log: AuthLogger = logger,
    ): Promise<OrganizationOnboardingResult> {
      /*
        A valid signature identifies a user; it does not entitle them
        (ADR-015 §7). `requireAccessToken` verified the token and nothing
        else, so the account is re-checked here with the same three-part gate
        `currentUser.service.ts` and `refresh.service.ts` apply — deliberately
        identical, so the three cannot drift about who Serviqo still serves.

        Two independent reasons this is required rather than defensive
        (ADR-016 §1a):

        - Without it, a disabled staff member keeps creating tenants for the
          remaining life of their access token, up to fifteen minutes.
        - `membership.model.ts` states the contract directly: "Verifying that
          the referenced User and Organization exist is the future business/
          service layer's job, before it asks persistence to create the
          relationship." A membership pointing at a deleted user is exactly
          the phantom record the schema declines to prevent itself.

        The refusal is the same generic 401 the credential paths use. It says
        nothing about why, for the reason ADR-015 §6 gives.
      */
      const user = await userRepository.findById(actor.userId);
      if (user === null || user.status !== "active" || user.emailVerifiedAt === null) {
        log.info(
          {
            event: "organization.creation_refused",
            reason: user === null ? "unknown_user" : "user_not_entitled",
            userId: actor.userId,
          },
          "Organization creation refused for an account that may no longer be served",
        );
        throw new InvalidAccessTokenError("Authentication required");
      }

      /*
        Generated here rather than by the database on insert, which is what
        makes the ordering below possible at all (ADR-016 §3).
      */
      const organizationId = new Types.ObjectId();

      /*
        The owner membership is written FIRST, and the organization LAST.

        Because the organization is the final write, there is no interleaving
        in which a tenant exists that nobody owns — the invariant is
        structural rather than checked. An ownerless organization would hold
        its unique slug forever with no one able to administer it, and no
        path exists (or is planned) by which a later request could adopt one,
        because "let an authenticated user claim an ownerless organization"
        is an account-takeover primitive.

        This is ordering, not a transaction. MongoDB transactions need a
        replica set; the development database is a standalone mongod and the
        test suites use MongoMemoryServer, so a transaction here would pass
        its tests and then fail the first time anyone created an organization
        locally. The inverse partial state — a membership pointing at an
        organization that does not exist — is reachable and accepted because
        it is inert: it grants nothing, it burns no slug, and the user
        retries successfully.
      */
      const membership = await membershipRepository.create({
        userId: actor.userId,
        organizationId,
        role: "owner",
        status: "active",
      });

      let organization: OrganizationDocument;
      try {
        organization = await createWithAvailableSlug(organizationId, input.name, log);
      } catch (err) {
        /*
          Compensation, permitted here for reasons `registration.service.ts`
          spelled out when it refused the same move: that path was
          unauthenticated and its partial state was recoverable. This one is
          authenticated, and a membership to a phantom tenant has no
          self-service repair (ADR-016 §4).

          Best-effort, and it never masks the original error — the caller's
          outcome must not change because bookkeeping did not. Exactly how
          `login.service.ts` treats a failed `clearLoginFailures`.
        */
        try {
          await membershipRepository.deleteById(membership._id);
        } catch (compensationError) {
          log.error(
            {
              event: "organization.compensation_failed",
              userId: actor.userId,
              organizationId: organizationId.toString(),
              membershipId: membership._id.toString(),
              failureType: failureType(compensationError),
            },
            "Organization creation failed and its owner membership could not be removed",
          );
        }

        log.info(
          {
            event: "organization.creation_failed",
            userId: actor.userId,
            organizationId: organizationId.toString(),
            failureType: failureType(err),
          },
          "Organization could not be created",
        );
        throw err;
      }

      /*
        The organization's NAME is deliberately absent from this line. It is
        user-submitted content, it triages nothing, and log lines are where
        tenant data leaks without anyone deciding to expose it (ADR-016 §9).
        The slug is included because it is a public URL segment by
        construction and is what an operator searches by.
      */
      log.info(
        {
          event: "organization.created",
          userId: actor.userId,
          organizationId: organization._id.toString(),
          membershipId: membership._id.toString(),
          slug: organization.slug,
        },
        "Organization created with its owner",
      );

      return { organization: toCreatedOrganization(organization), role: membership.role };
    },
  };
}
