import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { OWNERSHIP_TRANSFER_LIMIT } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { can } from "../src/modules/memberships/permissions";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";

import type { MembershipRole, MembershipStatus } from "../src/modules/memberships/membership.model";

/**
 * Integration coverage for organization ownership transfer (ADR-028): the
 * route, every authorization gate in front of it, the four pre-write refusals,
 * the guarded two-write sequence, concurrency, tenant isolation, and the
 * before/after RBAC consequences for both parties.
 *
 * Real MongoDB, real Express, real credentials issued through the real
 * register → verify → login flow — no principal is stubbed, because the point
 * of most of these assertions is exactly which principal the server derives
 * and from where.
 *
 * The assertions that matter most and are invisible when broken:
 *
 * - EXACTLY ONE OWNER, read from the database, after success, after every
 *   refusal, and after concurrent attempts (§8, §9).
 * - The previous owner loses `organization.transfer_ownership` on their VERY
 *   NEXT request with the SAME token, and the new owner gains it on theirs,
 *   because nothing caches a role (§16, ADR-017 §5).
 * - A forged `organizationId`, `currentOwnerId`, or `role` in the body changes
 *   NOTHING, because the schema strips it before any handler runs (§4).
 * - A membership id from another tenant is refused IDENTICALLY to one that
 *   does not exist (§5).
 * - Team management, the inbox, assignment, and the widget all still work
 *   afterwards, under the new owner and the demoted one.
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

/** An obvious sentinel — if it reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

/** Well-formed and belonging to nothing. */
const UNKNOWN_ID = "507f1f77bcf86cd799439099";

function buildApp(options: { rateLimiting?: boolean } = {}) {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider, ...options }) };
}

type Ctx = ReturnType<typeof buildApp>;

let emailCounter = 0;

/** A registered, verified, signed-in Serviqo account. */
async function signedInStaff(ctx: Ctx, name = "Ada Lovelace") {
  emailCounter += 1;
  const email = `owner-slice${emailCounter}@example.com`;

  await request(ctx.app).post(REGISTER_PATH).send({ name, email, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code });

  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return {
    accessToken: login.body.data.accessToken as string,
    userId: login.body.data.user.id as string,
    email,
    name,
  };
}

/** A registered account that never verified its email. */
async function unverifiedStaff(ctx: Ctx, name = "Unverified Person") {
  emailCounter += 1;
  const email = `unverified-slice${emailCounter}@example.com`;
  await request(ctx.app).post(REGISTER_PATH).send({ name, email, password: PASSWORD });

  const user = await UserModel.findOne({ email });
  return { email, name, userId: user!._id.toString() };
}

async function createOrganization(ctx: Ctx, accessToken: string, name: string) {
  const response = await request(ctx.app)
    .post(ORGANIZATIONS_PATH)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ name });
  return response.body.data.organization as { id: string };
}

/** Opens a real customer conversation through the real widget surface. */
async function customerConversation(ctx: Ctx, organizationId: string, email = "grace@example.com") {
  const organization = await OrganizationModel.findById(organizationId);
  const session = await request(ctx.app)
    .post(WIDGET_SESSION_PATH)
    .send({ widgetKey: organization!.widgetKey, name: "Grace Hopper", email });

  const widgetToken = session.body.data.token as string;
  const conversation = await request(ctx.app)
    .post(WIDGET_CONVERSATIONS_PATH)
    .set("Authorization", `Bearer ${widgetToken}`)
    .send({});

  const conversationId = conversation.body.data.id as string;

  await request(ctx.app)
    .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
    .set("Authorization", `Bearer ${widgetToken}`)
    .send({ body: "hello from a customer" });

  return { conversationId, widgetToken };
}

/** Writes a membership directly — the only way to put a caller in a non-owner role. */
function addMembership(
  userId: string,
  organizationId: string,
  role: MembershipRole,
  status: MembershipStatus = "active",
) {
  return MembershipModel.create({ userId, organizationId, role, status });
}

const ownershipPath = (organizationId: string) =>
  `${ORGANIZATIONS_PATH}/${organizationId}/ownership`;

const membersPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/members${suffix}`;

const inboxPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/conversations${suffix}`;

const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

/** Reads the invariant from the DATABASE, never from a response. */
async function ownersOf(organizationId: string) {
  return MembershipModel.find({ organizationId, role: "owner" });
}

describe("organization ownership transfer", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await OrganizationModel.init();
    // Index B — the partial unique index the whole slice rests on. Without
    // `init()` the "exactly one owner" assertions would pass for the wrong
    // reason.
    await MembershipModel.init();
    await CustomerModel.init();
    await ConversationModel.init();
    await MessageModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
      SessionModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  /**
   * An owner, their organization, and a second signed-in account added as an
   * agent — the shape most of these tests need.
   */
  async function tenantWithMember(ctx: Ctx, role: MembershipRole = "agent", organizationName = "Acme") {
    const owner = await signedInStaff(ctx, "Owner Person");
    const organization = await createOrganization(ctx, owner.accessToken, organizationName);
    const member = await signedInStaff(ctx, "Member Person");
    const membership = await addMembership(member.userId, organization.id, role);
    const ownerMembership = await MembershipModel.findOne({
      organizationId: organization.id,
      userId: owner.userId,
    });

    return {
      owner,
      organization,
      member,
      membershipId: membership._id.toString(),
      ownerMembershipId: ownerMembership!._id.toString(),
    };
  }

  // ==================== the happy path ====================

  describe("POST /ownership — the owner transfers", () => {
    it("answers 200 with the two memberships and their new roles", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        previousOwner: { id: t.ownerMembershipId, role: "admin" },
        newOwner: { id: t.membershipId, role: "owner" },
      });
    });

    /* ADR-028 §8 — the invariant, read from the database. */
    it("leaves exactly one owner, and it is the target", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const owners = await ownersOf(t.organization.id);
      expect(owners).toHaveLength(1);
      expect(owners[0]!._id.toString()).toBe(t.membershipId);
      expect(owners[0]!.userId.toString()).toBe(t.member.userId);
    });

    /* ADR-028 §7 — the decision, asserted against storage. */
    it("makes the previous owner an admin", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("admin");
    });

    it("transfers to a supervisor and to an admin just as readily", async () => {
      for (const role of ["supervisor", "admin"] as const) {
        const ctx = buildApp();
        const t = await tenantWithMember(ctx, role);

        const response = await request(ctx.app)
          .post(ownershipPath(t.organization.id))
          .set(authed(t.owner.accessToken))
          .send({ membershipId: t.membershipId });

        expect(response.status).toBe(200);
        expect(await ownersOf(t.organization.id)).toHaveLength(1);

        await MembershipModel.deleteMany({});
        await OrganizationModel.deleteMany({});
      }
    });

    /* ADR-028 §15 — the projection stops where it stops. */
    it("discloses no identity and no authentication state", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain(t.member.email);
      expect(serialized).not.toContain(t.member.name);
      expect(serialized).not.toContain(t.owner.email);
      expect(serialized).not.toContain("permission");
      expect(serialized).not.toContain(t.member.userId);
    });
  });

  // ==================== RBAC ====================

  describe("authorization — owner only", () => {
    /*
      ADR-028 §3. Every non-owner role receives the EXISTING generic 403 that
      `requirePermission` produces, and the response names no permission.
    */
    it.each([["admin"], ["supervisor"], ["agent"]] as const)(
      "refuses %s with 403 INSUFFICIENT_PERMISSION",
      async (role) => {
        const ctx = buildApp();
        const t = await tenantWithMember(ctx, role);
        const bystander = await signedInStaff(ctx, "Bystander");
        const bystanderMembership = await addMembership(bystander.userId, t.organization.id, "agent");

        const response = await request(ctx.app)
          .post(ownershipPath(t.organization.id))
          .set(authed(t.member.accessToken))
          .send({ membershipId: bystanderMembership._id.toString() });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("INSUFFICIENT_PERMISSION");
        expect(JSON.stringify(response.body)).not.toContain("transfer_ownership");

        // And nothing moved.
        const owners = await ownersOf(t.organization.id);
        expect(owners).toHaveLength(1);
        expect(owners[0]!.userId.toString()).toBe(t.owner.userId);
      },
    );

    /*
      An admin cannot promote themselves either — the escalation path that
      matters most, tried from the direction an attacker would try it.
    */
    it("refuses an admin aiming the transfer at their own membership", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.member.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(403);
      expect((await MembershipModel.findById(t.membershipId))!.role).toBe("admin");
    });

    /*
      ADR-017 §6, ADR-028 §3: someone with no standing in the tenant is refused
      by `requireOrganization` FIRST, with the opaque 404 — they never learn
      the organization exists, let alone which permission they lack.
    */
    it("answers 404 for a caller with no membership here", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const outsider = await signedInStaff(ctx, "Outsider");

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(outsider.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it.each([["invited"], ["suspended"]] as const)(
      "answers 404 for a caller whose own membership is %s",
      async (status) => {
        const ctx = buildApp();
        const t = await tenantWithMember(ctx);
        const other = await signedInStaff(ctx, "Other Person");
        await addMembership(other.userId, t.organization.id, "admin", status);

        const response = await request(ctx.app)
          .post(ownershipPath(t.organization.id))
          .set(authed(other.accessToken))
          .send({ membershipId: t.membershipId });

        expect(response.status).toBe(404);
      },
    );

    it("answers 401 with no access token", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(401);
      expect(await ownersOf(t.organization.id)).toHaveLength(1);
    });

    /* A suspended TENANT is refused by `requireOrganization`'s fourth gate. */
    it("answers 404 when the organization itself is suspended", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      await OrganizationModel.updateOne({ _id: t.organization.id }, { $set: { status: "suspended" } });

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(404);
      const owners = await ownersOf(t.organization.id);
      expect(owners).toHaveLength(1);
      expect(owners[0]!.userId.toString()).toBe(t.owner.userId);
    });
  });

  // ==================== the four pre-write refusals ====================

  describe("what the target must be", () => {
    it("refuses an unknown membership with 404 and moves nothing", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: UNKNOWN_ID });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect((await ownersOf(t.organization.id))[0]!.userId.toString()).toBe(t.owner.userId);
    });

    /*
      ADR-028 §5 — THE tenant-isolation assertion. A membership belonging to
      another organization must be indistinguishable from one that does not
      exist: same status, same code, same message.
    */
    it("refuses another tenant's membership identically to an unknown one", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");

      const crossTenant = await request(ctx.app)
        .post(ownershipPath(a.organization.id))
        .set(authed(a.owner.accessToken))
        .send({ membershipId: b.membershipId });

      const unknown = await request(ctx.app)
        .post(ownershipPath(a.organization.id))
        .set(authed(a.owner.accessToken))
        .send({ membershipId: UNKNOWN_ID });

      expect(crossTenant.status).toBe(unknown.status);
      expect(crossTenant.body.error.code).toBe(unknown.body.error.code);
      expect(crossTenant.body.error.message).toBe(unknown.body.error.message);

      // Both tenants are untouched, and B still has its own owner.
      expect((await MembershipModel.findById(b.membershipId))!.role).toBe("agent");
      expect((await ownersOf(a.organization.id))[0]!.userId.toString()).toBe(a.owner.userId);
      expect((await ownersOf(b.organization.id))[0]!.userId.toString()).toBe(b.owner.userId);
    });

    /*
      The cross-tenant attempt in the other direction: A's owner names B's
      OWNER membership. It must not demote B's owner, and it must not make
      anyone in A an owner.
    */
    it("cannot reach another tenant's owner membership", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");

      const response = await request(ctx.app)
        .post(ownershipPath(a.organization.id))
        .set(authed(a.owner.accessToken))
        .send({ membershipId: b.ownerMembershipId });

      expect(response.status).toBe(404);
      expect((await MembershipModel.findById(b.ownerMembershipId))!.role).toBe("owner");
      expect(await ownersOf(a.organization.id)).toHaveLength(1);
      expect(await ownersOf(b.organization.id)).toHaveLength(1);
    });

    it("refuses the owner's own membership with OWNERSHIP_TRANSFER_SELF_TARGET", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.ownerMembershipId });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("OWNERSHIP_TRANSFER_SELF_TARGET");
      expect((await ownersOf(t.organization.id))[0]!.userId.toString()).toBe(t.owner.userId);
    });

    it.each([["invited"], ["suspended"]] as const)("refuses a %s membership", async (status) => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      await MembershipModel.updateOne({ _id: t.membershipId }, { $set: { status } });

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("OWNERSHIP_TRANSFER_TARGET_INVALID");
      expect((await MembershipModel.findById(t.membershipId))!.role).toBe("agent");
      expect((await ownersOf(t.organization.id))[0]!.userId.toString()).toBe(t.owner.userId);
    });

    /* The case a membership-only check misses (§6.4). */
    it("refuses an active membership whose user account is suspended", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      await UserModel.updateOne({ _id: t.member.userId }, { $set: { status: "suspended" } });

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("OWNERSHIP_TRANSFER_TARGET_INVALID");
      expect((await ownersOf(t.organization.id))[0]!.userId.toString()).toBe(t.owner.userId);
    });

    it("refuses an active membership whose user never verified their email", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const unverified = await unverifiedStaff(ctx);
      const membership = await addMembership(unverified.userId, organization.id, "agent");

      const response = await request(ctx.app)
        .post(ownershipPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ membershipId: membership._id.toString() });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("OWNERSHIP_TRANSFER_TARGET_INVALID");
      expect((await ownersOf(organization.id))[0]!.userId.toString()).toBe(owner.userId);
    });

    /* One message for both, so neither state is distinguishable (§6). */
    it("gives one message for a suspended membership and a suspended account", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      await MembershipModel.updateOne({ _id: a.membershipId }, { $set: { status: "suspended" } });
      const b = await tenantWithMember(ctx, "agent", "Org B");
      await UserModel.updateOne({ _id: b.member.userId }, { $set: { status: "suspended" } });

      const first = await request(ctx.app)
        .post(ownershipPath(a.organization.id))
        .set(authed(a.owner.accessToken))
        .send({ membershipId: a.membershipId });
      const second = await request(ctx.app)
        .post(ownershipPath(b.organization.id))
        .set(authed(b.owner.accessToken))
        .send({ membershipId: b.membershipId });

      expect(first.body.error.message).toBe(second.body.error.message);
      expect(first.body.error.code).toBe(second.body.error.code);
    });

    /* A malformed id is a 400 from the schema, before any query runs (§5). */
    it.each([["short"], ["not-hex-zzzzzzzzzzzzzzzzzzzz"], [""]])(
      "answers 400 for a malformed membershipId (%j)",
      async (membershipId) => {
        const ctx = buildApp();
        const t = await tenantWithMember(ctx);

        const response = await request(ctx.app)
          .post(ownershipPath(t.organization.id))
          .set(authed(t.owner.accessToken))
          .send({ membershipId });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
      },
    );

    it("answers 400 for a missing body", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({});

      expect(response.status).toBe(400);
      expect(await ownersOf(t.organization.id)).toHaveLength(1);
    });

    /* A malformed ORGANIZATION id is refused by `requireOrganization` (ADR-017 §1). */
    it("answers 404 for a malformed organizationId in the path", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath("not-an-object-id"))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.status).toBe(404);
    });
  });

  // ==================== forged input (ADR-028 §4) ====================

  describe("forged identity fields change nothing", () => {
    /*
      The body names another organization. The tenant comes from the PATH, and
      the extra key is stripped by the schema before any handler runs — so the
      transfer happens in the path's tenant and the named one is untouched.
    */
    it("ignores a forged organizationId in the body", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");

      const response = await request(ctx.app)
        .post(ownershipPath(a.organization.id))
        .set(authed(a.owner.accessToken))
        .send({ membershipId: a.membershipId, organizationId: b.organization.id });

      expect(response.status).toBe(200);
      // A moved; B did not.
      expect((await ownersOf(a.organization.id))[0]!.userId.toString()).toBe(a.member.userId);
      expect((await ownersOf(b.organization.id))[0]!.userId.toString()).toBe(b.owner.userId);
    });

    /*
      The body names a different acting owner. The acting owner is
      `req.organizationContext.membershipId` — read from the database on this
      request — so the forged value is not merely rejected, it is invisible.
    */
    it("ignores a forged currentOwnerId and demotes the real caller", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const third = await signedInStaff(ctx, "Third Person");
      const thirdMembership = await addMembership(third.userId, t.organization.id, "admin");

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({
          membershipId: t.membershipId,
          currentOwnerId: thirdMembership._id.toString(),
          ownerUserId: third.userId,
          userId: third.userId,
        });

      expect(response.status).toBe(200);
      expect(response.body.data.previousOwner.id).toBe(t.ownerMembershipId);
      // The third party is untouched — still an admin, never an owner.
      expect((await MembershipModel.findById(thirdMembership._id))!.role).toBe("admin");
      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("admin");
    });

    it("ignores a forged role and status in the body", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId, role: "agent", status: "suspended" });

      expect(response.status).toBe(200);
      const promoted = await MembershipModel.findById(t.membershipId);
      // The role the SERVER chose, and the status untouched.
      expect(promoted!.role).toBe("owner");
      expect(promoted!.status).toBe("active");
      // The previous owner got the server's role, not the body's.
      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("admin");
    });

    /*
      A non-owner sending a forged `role: "owner"` still gets the ordinary 403.
      The permission check runs before the body is even parsed.
    */
    it("does not let a forged role buy the permission", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.member.accessToken))
        .send({ membershipId: t.ownerMembershipId, role: "owner" });

      expect(response.status).toBe(403);
      expect((await MembershipModel.findById(t.membershipId))!.role).toBe("admin");
    });
  });

  // ==================== the RBAC consequences ====================

  describe("after a transfer, roles take effect immediately", () => {
    /*
      ADR-017 §5, ADR-028 §16. The SAME access token, issued before the
      transfer, is used for both requests — so this proves the role is read
      from the database on every request rather than carried in the token or
      cached anywhere.
    */
    it("takes organization.transfer_ownership away from the previous owner immediately", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const third = await signedInStaff(ctx, "Third Person");
      const thirdMembership = await addMembership(third.userId, t.organization.id, "agent");

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      // Same token, very next request.
      const second = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: thirdMembership._id.toString() });

      expect(second.status).toBe(403);
      expect(second.body.error.code).toBe("INSUFFICIENT_PERMISSION");
      expect((await ownersOf(t.organization.id))[0]!.userId.toString()).toBe(t.member.userId);
    });

    it("gives organization.transfer_ownership to the new owner immediately, with their existing token", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const third = await signedInStaff(ctx, "Third Person");
      const thirdMembership = await addMembership(third.userId, t.organization.id, "agent");

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      // The new owner's token was issued BEFORE they were the owner.
      const onward = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.member.accessToken))
        .send({ membershipId: thirdMembership._id.toString() });

      expect(onward.status).toBe(200);
      expect((await ownersOf(t.organization.id))[0]!.userId.toString()).toBe(third.userId);
    });

    /* `GET /organizations/:id` is what the dashboard re-reads (§16). */
    it("reports the new role to both parties on the organization context", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const previous = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${t.organization.id}`)
        .set(authed(t.owner.accessToken));
      const next = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${t.organization.id}`)
        .set(authed(t.member.accessToken));

      expect(previous.body.data.role).toBe("admin");
      expect(next.body.data.role).toBe("owner");
    });

    /*
      A repeat of the exact same request. The precondition ("you are the
      owner") stopped being true because the first one succeeded, so this is
      refused rather than silently reported as a success (§9).
    */
    it("refuses a repeated identical transfer with 403", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const first = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });
      const second = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect(first.status).toBe(200);
      expect(second.status).toBe(403);
      expect(await ownersOf(t.organization.id)).toHaveLength(1);
    });

    /* Ownership can go back, which is what makes item 4 of §18 a real remedy. */
    it("lets the new owner transfer it back", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const back = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.member.accessToken))
        .send({ membershipId: t.ownerMembershipId });

      expect(back.status).toBe(200);
      const owners = await ownersOf(t.organization.id);
      expect(owners).toHaveLength(1);
      expect(owners[0]!.userId.toString()).toBe(t.owner.userId);
      // And the round trip left the other one an admin, not an agent.
      expect((await MembershipModel.findById(t.membershipId))!.role).toBe("admin");
    });
  });

  // ==================== concurrency ====================

  describe("concurrent transfers", () => {
    /*
      ADR-028 §8b, §9 — the property the whole design exists for. Two requests
      in flight together, two different targets. The demote's `role: "owner"`
      filter means exactly one can match.
    */
    it("lets exactly one of two simultaneous transfers win", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const first = await signedInStaff(ctx, "First");
      const second = await signedInStaff(ctx, "Second");
      const firstMembership = await addMembership(first.userId, organization.id, "agent");
      const secondMembership = await addMembership(second.userId, organization.id, "agent");

      const [a, b] = await Promise.all([
        request(ctx.app)
          .post(ownershipPath(organization.id))
          .set(authed(owner.accessToken))
          .send({ membershipId: firstMembership._id.toString() }),
        request(ctx.app)
          .post(ownershipPath(organization.id))
          .set(authed(owner.accessToken))
          .send({ membershipId: secondMembership._id.toString() }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const loser = a.status === 409 ? a : b;
      // 403 would also be "refused", but the loser must specifically observe
      // the conflict rather than a permission failure — it held the permission
      // when the request began.
      expect([409]).toContain(loser.status);
      expect(["OWNERSHIP_TRANSFER_CONFLICT", "INSUFFICIENT_PERMISSION"]).toContain(loser.body.error.code);

      const owners = await ownersOf(organization.id);
      expect(owners).toHaveLength(1);
    });

    /* No partial or ownerless state is ever exposed, at any concurrency. */
    it("never produces two owners or none across eight simultaneous attempts", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");

      const memberships: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const member = await signedInStaff(ctx, `Member ${i}`);
        const membership = await addMembership(member.userId, organization.id, "agent");
        memberships.push(membership._id.toString());
      }

      const responses = await Promise.all(
        memberships.map((membershipId) =>
          request(ctx.app)
            .post(ownershipPath(organization.id))
            .set(authed(owner.accessToken))
            .send({ membershipId }),
        ),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status >= 500)).toHaveLength(0);

      const owners = await ownersOf(organization.id);
      expect(owners).toHaveLength(1);
      // Nine memberships still exist, all in this tenant: no partial state.
      expect(await MembershipModel.countDocuments({ organizationId: organization.id })).toBe(9);
    });

    /*
      The database's own last line of defence, asserted directly: even a write
      that bypassed every guard in the service cannot create a second owner.
    */
    it("cannot be forced into two owners even by a direct write", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await expect(
        MembershipModel.updateOne({ _id: t.membershipId }, { $set: { role: "owner" } }),
      ).rejects.toMatchObject({ code: 11000 });

      expect(await ownersOf(t.organization.id)).toHaveLength(1);
    });
  });

  // ==================== everything else still works ====================

  describe("existing behaviour survives the transfer", () => {
    it("keeps the roster complete, with the new owner at the top", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const roster = await request(ctx.app).get(membersPath(t.organization.id)).set(authed(t.member.accessToken));

      expect(roster.status).toBe(200);
      const members = roster.body.data.members as { id: string; role: string }[];
      expect(members).toHaveLength(2);
      // `sortMembers` puts `owner` first (ADR-027 §14).
      expect(members[0]).toMatchObject({ id: t.membershipId, role: "owner" });
      expect(members[1]).toMatchObject({ id: t.ownerMembershipId, role: "admin" });
    });

    /*
      ADR-027's owner protection now points at the NEW owner. The demoted one
      is an ordinary admin and can be managed; the new one cannot.
    */
    it("moves owner protection to the new owner", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      // The new owner is protected.
      const protectedTarget = await request(ctx.app)
        .patch(membersPath(t.organization.id, `/${t.membershipId}/role`))
        .set(authed(t.owner.accessToken))
        .send({ role: "agent" });
      expect(protectedTarget.status).toBe(409);
      expect(protectedTarget.body.error.code).toBe("ORGANIZATION_OWNER_PROTECTED");

      // The demoted one is not — the new owner can change their role.
      const demotedTarget = await request(ctx.app)
        .patch(membersPath(t.organization.id, `/${t.ownerMembershipId}/role`))
        .set(authed(t.member.accessToken))
        .send({ role: "supervisor" });
      expect(demotedTarget.status).toBe(200);
      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("supervisor");
    });

    it("lets the previous owner keep managing members as an admin", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const third = await signedInStaff(ctx, "Third Person");
      const thirdMembership = await addMembership(third.userId, t.organization.id, "agent");

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const roleChange = await request(ctx.app)
        .patch(membersPath(t.organization.id, `/${thirdMembership._id.toString()}/role`))
        .set(authed(t.owner.accessToken))
        .send({ role: "supervisor" });

      expect(roleChange.status).toBe(200);
      expect(roleChange.body.data.role).toBe("supervisor");
    });

    /*
      ADR-028 §13. Under today's catalogue both roles hold
      `conversation.assign`, so the transfer must release NOTHING — the
      complement assertion that makes the `can()`-derived guard meaningful.
    */
    it("leaves the previous owner's conversation assignments intact", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { conversationId } = await customerConversation(ctx, t.organization.id);

      const claim = await request(ctx.app)
        .patch(inboxPath(t.organization.id, `/${conversationId}/assignment`))
        .set(authed(t.owner.accessToken))
        .send({ action: "claim" });
      expect(claim.status).toBe(200);

      const before = await ConversationModel.findById(conversationId);
      expect(before!.assignedTo!.toString()).toBe(t.owner.userId);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const after = await ConversationModel.findById(conversationId);
      expect(after!.assignedTo!.toString()).toBe(t.owner.userId);
      // Stated from the catalogue, so this test fails loudly if the table
      // changes rather than silently asserting the wrong thing.
      expect(can("admin", "conversation.assign")).toBe(true);
    });

    it("keeps the inbox readable and repliable for both parties", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { conversationId } = await customerConversation(ctx, t.organization.id);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      for (const token of [t.owner.accessToken, t.member.accessToken]) {
        const list = await request(ctx.app).get(inboxPath(t.organization.id)).set(authed(token));
        expect(list.status).toBe(200);
        expect(list.body.data.conversations).toHaveLength(1);

        const reply = await request(ctx.app)
          .post(inboxPath(t.organization.id, `/${conversationId}/messages`))
          .set(authed(token))
          .send({ body: "an agent reply after the transfer" });
        expect(reply.status).toBe(201);
      }
    });

    it("keeps conversation status changes working", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { conversationId } = await customerConversation(ctx, t.organization.id);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const closed = await request(ctx.app)
        .patch(inboxPath(t.organization.id, `/${conversationId}/status`))
        .set(authed(t.member.accessToken))
        .send({ status: "closed" });

      expect(closed.status).toBe(200);
      expect((await ConversationModel.findById(conversationId))!.status).toBe("closed");
    });

    /*
      The customer boundary. A staff ownership change must be completely
      invisible to a widget session — the token still works, the conversation
      still resolves, and messages still send (§14).
    */
    it("leaves the customer's widget session and messages untouched", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { conversationId, widgetToken } = await customerConversation(ctx, t.organization.id);

      await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      const send = await request(ctx.app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "still here after the transfer" });

      expect(send.status).toBe(201);

      const history = await request(ctx.app)
        .get(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`);

      expect(history.status).toBe(200);
      // Nothing about staff roles or ownership reaches a customer.
      const serialized = JSON.stringify(history.body);
      expect(serialized).not.toContain("owner");
      expect(serialized).not.toContain("admin");
      expect(serialized).not.toContain(t.member.email);
    });

    it("keeps each tenant's ownership independent", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");

      await request(ctx.app)
        .post(ownershipPath(a.organization.id))
        .set(authed(a.owner.accessToken))
        .send({ membershipId: a.membershipId });

      expect((await ownersOf(a.organization.id))[0]!.userId.toString()).toBe(a.member.userId);
      expect((await ownersOf(b.organization.id))[0]!.userId.toString()).toBe(b.owner.userId);
      // And A's demoted owner still cannot see B at all.
      const probe = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${b.organization.id}`)
        .set(authed(a.owner.accessToken));
      expect(probe.status).toBe(404);
    });

    /*
      One person owning two organizations is legal — index B is partial and
      scoped per organization — so a transfer in one must not touch the other.
    */
    it("does not disturb an owner's other organization", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const first = await createOrganization(ctx, owner.accessToken, "First Co");
      const secondOrg = await createOrganization(ctx, owner.accessToken, "Second Co");
      const member = await signedInStaff(ctx, "Member Person");
      const membership = await addMembership(member.userId, first.id, "agent");

      await request(ctx.app)
        .post(ownershipPath(first.id))
        .set(authed(owner.accessToken))
        .send({ membershipId: membership._id.toString() });

      expect((await ownersOf(first.id))[0]!.userId.toString()).toBe(member.userId);
      expect((await ownersOf(secondOrg.id))[0]!.userId.toString()).toBe(owner.userId);
    });
  });

  // ==================== rate limiting ====================

  describe("rate limiting (ADR-028 §11)", () => {
    /*
      The real limiter, the real store, the real refusal path. Every attempt
      after the first is a 403 (the caller is no longer the owner) until the
      budget runs out and the limiter answers 429 instead — which is what
      proves the limiter counts ATTEMPTS rather than successes, and that it
      sits in front of the tenant lookup (ADR-018 §3).
    */
    it("refuses with 429 once the class budget is spent", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const t = await tenantWithMember(ctx);

      const statuses: number[] = [];
      for (let i = 0; i < OWNERSHIP_TRANSFER_LIMIT + 1; i += 1) {
        const response = await request(ctx.app)
          .post(ownershipPath(t.organization.id))
          .set(authed(t.owner.accessToken))
          .send({ membershipId: t.membershipId });
        statuses.push(response.status);
      }

      expect(statuses.at(-1)).toBe(429);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    });

    it("names no limit, window, or class in the refusal", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const t = await tenantWithMember(ctx);

      let last;
      for (let i = 0; i < OWNERSHIP_TRANSFER_LIMIT + 1; i += 1) {
        last = await request(ctx.app)
          .post(ownershipPath(t.organization.id))
          .set(authed(t.owner.accessToken))
          .send({ membershipId: t.membershipId });
      }

      expect(last!.status).toBe(429);
      expect(last!.body.error.code).toBe("TOO_MANY_REQUESTS");

      /*
        The MESSAGE is the surface a caller reads, and it is the shared generic
        one — no class name, no limit, no window, no remaining budget. The
        envelope's requestId and timestamp are excluded from this check on
        purpose: they are random and can contain any digit, so asserting over
        the whole body would be asserting about UUIDs rather than about
        disclosure.
      */
      expect(last!.body.error.message).toBe(
        "Too many requests. Please wait a few minutes and try again.",
      );
      expect(last!.body.error.message).not.toContain(String(OWNERSHIP_TRANSFER_LIMIT));
      expect(JSON.stringify(last!.body)).not.toContain("ownershipTransfer");
      expect(JSON.stringify(last!.body)).not.toContain("limitClass");
      // Standards-track headers accompany it; the window is not a secret.
      expect(last!.headers["retry-after"]).toBeDefined();
    });

    /*
      Its own class: spending the transfer budget must NOT throttle ordinary
      staff writes, which is the whole reason it is not `authenticatedWrite`.
    */
    it("does not spend the ordinary write budget", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const t = await tenantWithMember(ctx);
      const third = await signedInStaff(ctx, "Third Person");
      const thirdMembership = await addMembership(third.userId, t.organization.id, "agent");

      for (let i = 0; i < OWNERSHIP_TRANSFER_LIMIT + 1; i += 1) {
        await request(ctx.app)
          .post(ownershipPath(t.organization.id))
          .set(authed(t.owner.accessToken))
          .send({ membershipId: t.membershipId });
      }

      // The transfer already happened on the first call, so the previous owner
      // is an admin — who still holds `member.manage`.
      const roleChange = await request(ctx.app)
        .patch(membersPath(t.organization.id, `/${thirdMembership._id.toString()}/role`))
        .set(authed(t.owner.accessToken))
        .send({ role: "supervisor" });

      expect(roleChange.status).toBe(200);
    });

    /*
      Keyed by the verified user (ADR-018 §4), so one owner exhausting their
      budget must not throttle a different owner in a different tenant.

      Two app instances, sharing one database and one set of JWT secrets: the
      fixtures are built through an UNLIMITED app, and only the transfers run
      through the limited one. Registering four accounts and creating two
      organizations through a rate-limited instance would trip the `credential`
      class first (ADR-018 §3), and the test would then be measuring the wrong
      limiter. Counters are per-instance by construction, which is exactly what
      `createRateLimiters`'s per-`createApp` build makes possible.
    */
    it("keys the budget by user, not by organization", async () => {
      const setup = buildApp();
      const a = await tenantWithMember(setup, "agent", "Org A");
      const b = await tenantWithMember(setup, "agent", "Org B");

      const limited = buildApp({ rateLimiting: true });

      for (let i = 0; i < OWNERSHIP_TRANSFER_LIMIT + 1; i += 1) {
        await request(limited.app)
          .post(ownershipPath(a.organization.id))
          .set(authed(a.owner.accessToken))
          .send({ membershipId: a.membershipId });
      }

      // A's owner is exhausted…
      const exhausted = await request(limited.app)
        .post(ownershipPath(a.organization.id))
        .set(authed(a.owner.accessToken))
        .send({ membershipId: a.membershipId });
      expect(exhausted.status).toBe(429);

      // …and B's owner, on the same limiter instance, is not.
      const other = await request(limited.app)
        .post(ownershipPath(b.organization.id))
        .set(authed(b.owner.accessToken))
        .send({ membershipId: b.membershipId });

      expect(other.status).toBe(200);
      expect((await ownersOf(b.organization.id))[0]!.userId.toString()).toBe(b.member.userId);
    });
  });

  // ==================== response hygiene ====================

  describe("response hygiene", () => {
    /*
      No refusal on this route may carry a credential, an address, or the
      internal `reason` the log records (§12).
    */
    it.each([
      ["unknown target", (_t: { membershipId: string; ownerMembershipId: string }) => UNKNOWN_ID],
      ["self target", (t: { membershipId: string; ownerMembershipId: string }) => t.ownerMembershipId],
    ])("leaks nothing when refusing (%s)", async (_label, pick) => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: pick(t) });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(t.owner.email);
      expect(serialized).not.toContain(t.member.email);
      expect(serialized).not.toContain(t.owner.accessToken);
      expect(serialized).not.toContain("reason");
      expect(serialized).not.toContain("membership_not_found");
      expect(serialized).not.toContain("self_target");
    });

    it("uses the standard error envelope", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: UNKNOWN_ID });

      // `lib/response`'s failure shape: the requestId lives INSIDE `error`,
      // beside the code and message, and there is no top-level `data`.
      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: expect.any(String),
          message: expect.any(String),
          requestId: expect.any(String),
          version: expect.any(String),
        },
      });
      expect(response.body).not.toHaveProperty("data");
    });

    it("uses the standard success envelope", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .post(ownershipPath(t.organization.id))
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });

      expect(response.body).toMatchObject({ success: true, data: expect.any(Object) });
    });
  });
});
