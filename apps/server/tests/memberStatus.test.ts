import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AUTHENTICATED_WRITE_LIMIT } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";

import type { MembershipRole, MembershipStatus } from "../src/modules/memberships/membership.model";
import { createOrganizationAs } from "../src/modules/organizations/testing/organizations";

/**
 * Integration coverage for membership suspension and reactivation (ADR-029):
 * the route, every authorization gate in front of it, the transition table,
 * owner protection, tenant isolation, the assignment cleanup, and — the
 * assertion this slice exists for — that a suspended member's EXISTING access
 * token stops authorizing them on their very next request.
 *
 * Real MongoDB, real Express, real credentials issued through the real
 * register → verify → login flow. No principal is stubbed, because the point
 * of most of these assertions is exactly which principal the server derives
 * and from where.
 *
 * The assertions that matter most and are invisible when broken:
 *
 * - A suspended member is refused on EVERY organization-scoped staff route,
 *   with the token they already held, with no re-login and no new gate —
 *   `requireOrganization` has refused non-active memberships since ADR-017 §2
 *   and this slice finally gives it something to refuse (§8).
 * - Reactivation restores that access just as immediately, and restores NO
 *   assignments (§10).
 * - The owner cannot be suspended by any caller, and exactly one ACTIVE owner
 *   survives every attempt (§7).
 * - A cross-tenant membership id is refused identically to an unknown one (§5).
 * - A forged `organizationId`/`userId`/`role`/`membershipId` in the body
 *   changes nothing, because the schema strips it before any handler runs (§4).
 */

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

async function signedInStaff(ctx: Ctx, name = "Ada Lovelace") {
  emailCounter += 1;
  const email = `status${emailCounter}@example.com`;

  await createStaffAccount(ctx.fake.provider, { name, email, password: PASSWORD });
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

async function createOrganization(_ctx: Ctx, accessToken: string, name: string) {
  return (await createOrganizationAs(accessToken, name)) as { id: string };
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

function addMembership(
  userId: string,
  organizationId: string,
  role: MembershipRole,
  status: MembershipStatus = "active",
) {
  return MembershipModel.create({ userId, organizationId, role, status });
}

const membersPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/members${suffix}`;

const statusPath = (organizationId: string, membershipId: string) =>
  membersPath(organizationId, `/${membershipId}/status`);

const rolePath = (organizationId: string, membershipId: string) =>
  membersPath(organizationId, `/${membershipId}/role`);

const inboxPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/conversations${suffix}`;

const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

async function statusOf(membershipId: string) {
  return (await MembershipModel.findById(membershipId))?.status ?? null;
}

describe("membership suspension and reactivation", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await OrganizationModel.init();
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

  /** An owner, their organization, and one signed-in member in the given role. */
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

  // ==================== the two transitions ====================

  describe("PATCH /status — suspending and reactivating", () => {
    it("suspends an active member and answers 200 with the roster projection", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(200);
      expect(response.body.data.member).toMatchObject({ id: t.membershipId, status: "suspended", role: "agent" });
      expect(response.body.data.releasedConversations).toBe(0);
      expect(await statusOf(t.membershipId)).toBe("suspended");
    });

    it("reactivates a suspended member", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      await MembershipModel.updateOne({ _id: t.membershipId }, { $set: { status: "suspended" } });

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "active" });

      expect(response.status).toBe(200);
      expect(response.body.data.member.status).toBe("active");
      expect(await statusOf(t.membershipId)).toBe("active");
    });

    it("does not change the member's role", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "supervisor");

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect((await MembershipModel.findById(t.membershipId))!.role).toBe("supervisor");
    });

    it("discloses no authentication state", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("failedLoginAttempts");
      expect(serialized).not.toContain("reason");
    });
  });

  // ==================== the transitions that do not exist ====================

  describe("invalid transitions", () => {
    it.each([
      ["active", "active"],
      ["suspended", "suspended"],
    ] as const)("refuses the no-op %s → %s", async (from, to) => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      await MembershipModel.updateOne({ _id: t.membershipId }, { $set: { status: from } });

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: to });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_STATUS_TRANSITION_INVALID");
      expect(await statusOf(t.membershipId)).toBe(from);
    });

    it.each([["active"], ["suspended"]] as const)("refuses an invited membership going to %s", async (to) => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      await MembershipModel.updateOne({ _id: t.membershipId }, { $set: { status: "invited" } });

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: to });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_STATUS_TRANSITION_INVALID");
      expect(await statusOf(t.membershipId)).toBe("invited");
    });

    /* `invited` is not a value a request may name at all (ADR-029 §3). */
    it("refuses status: invited with a 400 from the schema", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "invited" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await statusOf(t.membershipId)).toBe("active");
    });

    it.each([["removed"], ["deleted"], ["ACTIVE"], [""]])("refuses status %j with a 400", async (status) => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status });

      expect(response.status).toBe(400);
    });

    it("refuses a missing body", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({});

      expect(response.status).toBe(400);
    });

    it("refuses a malformed membershipId with 400, not 500", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, "not-an-object-id"))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ==================== RBAC ====================

  describe("authorization — member.manage only", () => {
    it("lets the owner suspend", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(200);
    });

    it("lets an admin suspend an eligible member", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");
      const target = await signedInStaff(ctx, "Target Person");
      const targetMembership = await addMembership(target.userId, t.organization.id, "agent");

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, targetMembership._id.toString()))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(200);
      expect(await statusOf(targetMembership._id.toString())).toBe("suspended");
    });

    /*
      `supervisor` holds `member.read` and NOT `member.manage` — the gradient
      that makes this route's guard meaningful (ADR-029 §2).
    */
    it.each([["supervisor"], ["agent"]] as const)("refuses %s with 403", async (role) => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, role);
      const target = await signedInStaff(ctx, "Target Person");
      const targetMembership = await addMembership(target.userId, t.organization.id, "agent");

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, targetMembership._id.toString()))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("INSUFFICIENT_PERMISSION");
      expect(await statusOf(targetMembership._id.toString())).toBe("active");
    });

    /* A supervisor can READ the roster and still cannot change a status. */
    it("lets a supervisor read the roster it may not modify", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "supervisor");

      const roster = await request(ctx.app).get(membersPath(t.organization.id)).set(authed(t.member.accessToken));
      expect(roster.status).toBe(200);

      const write = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.ownerMembershipId))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });
      expect(write.status).toBe(403);
    });

    it("answers 404 for a caller with no membership here", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const outsider = await signedInStaff(ctx, "Outsider");

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(outsider.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(await statusOf(t.membershipId)).toBe("active");
    });

    it("answers 401 with no access token", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .send({ status: "suspended" });

      expect(response.status).toBe(401);
    });

    it("answers 404 when the organization itself is suspended", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      await OrganizationModel.updateOne({ _id: t.organization.id }, { $set: { status: "suspended" } });

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(404);
    });

    /* A manager whose own membership was suspended cannot manage anyone. */
    it("refuses a suspended admin, on their next request", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");
      const target = await signedInStaff(ctx, "Target Person");
      const targetMembership = await addMembership(target.userId, t.organization.id, "agent");

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, targetMembership._id.toString()))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(404);
      expect(await statusOf(targetMembership._id.toString())).toBe("active");
    });
  });

  // ==================== owner protection ====================

  describe("owner protection", () => {
    it("refuses to suspend the owner, even for the owner themselves", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.ownerMembershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ORGANIZATION_OWNER_PROTECTED");
      expect(await statusOf(t.ownerMembershipId)).toBe("active");
    });

    it("refuses to suspend the owner when an admin tries", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.ownerMembershipId))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ORGANIZATION_OWNER_PROTECTED");
      expect(await statusOf(t.ownerMembershipId)).toBe("active");
    });

    it("leaves exactly one ACTIVE owner after every refused attempt", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.ownerMembershipId))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });

      const owners = await MembershipModel.find({ organizationId: t.organization.id, role: "owner" });
      expect(owners).toHaveLength(1);
      expect(owners[0]!.status).toBe("active");
    });

    /* A direct write cannot do it either — the repository filter is a backstop. */
    it("cannot be reached even by aiming the repository at the owner", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { membershipRepository } = await import("../src/modules/memberships/membership.repository");

      const result = await membershipRepository.updateStatusForOrganization(
        t.ownerMembershipId,
        t.organization.id,
        "active",
        "suspended",
      );

      expect(result).toBeNull();
      expect(await statusOf(t.ownerMembershipId)).toBe("active");
    });

    it("refuses the caller's own membership", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_SELF_MODIFICATION");
      expect(await statusOf(t.membershipId)).toBe("active");
    });

    /*
      ADR-029 §7's ordering rule, end to end: transfer first, then suspend.
      After a transfer the previous owner is an `admin` and becomes an ordinary
      target, while the NEW owner is protected from that moment.
    */
    it("protects the new owner and releases the old one after an ownership transfer", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");

      const transfer = await request(ctx.app)
        .post(`${ORGANIZATIONS_PATH}/${t.organization.id}/ownership`)
        .set(authed(t.owner.accessToken))
        .send({ membershipId: t.membershipId });
      expect(transfer.status).toBe(200);

      // The NEW owner is protected.
      const protectedNew = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });
      expect(protectedNew.status).toBe(409);
      expect(protectedNew.body.error.code).toBe("ORGANIZATION_OWNER_PROTECTED");

      // The PREVIOUS owner, now an admin, can be suspended by the new owner.
      const suspendOld = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.ownerMembershipId))
        .set(authed(t.member.accessToken))
        .send({ status: "suspended" });
      expect(suspendOld.status).toBe(200);
      expect(await statusOf(t.ownerMembershipId)).toBe("suspended");

      // And ownership is still exactly one active owner.
      const owners = await MembershipModel.find({ organizationId: t.organization.id, role: "owner" });
      expect(owners).toHaveLength(1);
      expect(owners[0]!.status).toBe("active");
      expect(owners[0]!.userId.toString()).toBe(t.member.userId);
    });
  });

  // ==================== tenant isolation and forged input ====================

  describe("isolation", () => {
    it("refuses another tenant's membership identically to an unknown one", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");

      const crossTenant = await request(ctx.app)
        .patch(statusPath(a.organization.id, b.membershipId))
        .set(authed(a.owner.accessToken))
        .send({ status: "suspended" });

      const unknown = await request(ctx.app)
        .patch(statusPath(a.organization.id, UNKNOWN_ID))
        .set(authed(a.owner.accessToken))
        .send({ status: "suspended" });

      expect(crossTenant.status).toBe(unknown.status);
      expect(crossTenant.body.error.code).toBe(unknown.body.error.code);
      expect(crossTenant.body.error.message).toBe(unknown.body.error.message);
      expect(await statusOf(b.membershipId)).toBe("active");
    });

    it("cannot reach another tenant's owner", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");

      const response = await request(ctx.app)
        .patch(statusPath(a.organization.id, b.ownerMembershipId))
        .set(authed(a.owner.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(404);
      expect(await statusOf(b.ownerMembershipId)).toBe("active");
    });

    /* ADR-029 §4 — the tenant is the PATH, and a body value is stripped. */
    it("ignores a forged organizationId in the body", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");

      const response = await request(ctx.app)
        .patch(statusPath(a.organization.id, a.membershipId))
        .set(authed(a.owner.accessToken))
        .send({ status: "suspended", organizationId: b.organization.id });

      expect(response.status).toBe(200);
      expect(await statusOf(a.membershipId)).toBe("suspended");
      expect(await statusOf(b.membershipId)).toBe("active");
    });

    it("ignores a forged membershipId in the body — the path wins", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const other = await signedInStaff(ctx, "Other Person");
      const otherMembership = await addMembership(other.userId, t.organization.id, "agent");

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended", membershipId: otherMembership._id.toString() });

      expect(response.status).toBe(200);
      expect(await statusOf(t.membershipId)).toBe("suspended");
      expect(await statusOf(otherMembership._id.toString())).toBe("active");
    });

    it("ignores a forged userId and role", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended", userId: t.owner.userId, role: "owner", invitedByUserId: t.owner.userId });

      expect(response.status).toBe(200);
      const stored = await MembershipModel.findById(t.membershipId);
      expect(stored!.role).toBe("agent");
      expect(stored!.userId.toString()).toBe(t.member.userId);
      // And the owner is untouched.
      expect(await statusOf(t.ownerMembershipId)).toBe("active");
    });

    it("ignores a forged current status", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      // Claiming the member is already suspended must not make "suspended →
      // active" legal against a document that is actually `active`.
      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "active", currentStatus: "suspended" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_STATUS_TRANSITION_INVALID");
      expect(await statusOf(t.membershipId)).toBe("active");
    });
  });

  // ==================== immediate authorization loss and restoration ====================

  describe("suspension takes effect on the next request", () => {
    /**
     * Every organization-scoped staff surface, exercised with the SAME token
     * before and after. Nothing is re-issued and nothing is logged in again —
     * which is the whole property (ADR-029 §8).
     */
    async function staffProbes(ctx: Ctx, organizationId: string, token: string, conversationId: string) {
      return {
        context: (await request(ctx.app).get(`${ORGANIZATIONS_PATH}/${organizationId}`).set(authed(token))).status,
        inbox: (await request(ctx.app).get(inboxPath(organizationId)).set(authed(token))).status,
        history: (
          await request(ctx.app).get(inboxPath(organizationId, `/${conversationId}/messages`)).set(authed(token))
        ).status,
        reply: (
          await request(ctx.app)
            .post(inboxPath(organizationId, `/${conversationId}/messages`))
            .set(authed(token))
            .send({ body: "an agent reply" })
        ).status,
        claim: (
          await request(ctx.app)
            .patch(inboxPath(organizationId, `/${conversationId}/assignment`))
            .set(authed(token))
            .send({ action: "claim" })
        ).status,
        roster: (await request(ctx.app).get(membersPath(organizationId)).set(authed(token))).status,
      };
    }

    it("refuses every staff route with the token the member already held", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");
      const { conversationId } = await customerConversation(ctx, t.organization.id);

      const before = await staffProbes(ctx, t.organization.id, t.member.accessToken, conversationId);
      expect(before.context).toBe(200);
      expect(before.inbox).toBe(200);
      expect(before.roster).toBe(200);

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      // THE SAME TOKEN. No re-login, no refresh, no new session.
      const after = await staffProbes(ctx, t.organization.id, t.member.accessToken, conversationId);
      expect(after.context).toBe(404);
      expect(after.inbox).toBe(404);
      expect(after.history).toBe(404);
      expect(after.reply).toBe(404);
      expect(after.claim).toBe(404);
      expect(after.roster).toBe(404);
    });

    /*
      The token still AUTHENTICATES — the member is still a Serviqo user. It
      simply no longer AUTHORIZES them in this tenant (ADR-029 §8).
    */
    it("leaves the suspended member's own account reachable", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const me = await request(ctx.app).get("/api/v1/auth/me").set(authed(t.member.accessToken));
      expect(me.status).toBe(200);
      expect(me.body.data.user.id).toBe(t.member.userId);
    });

    /* Their OTHER organizations are untouched — not this tenant's decision. */
    it("does not touch the member's other organizations", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const elsewhere = await createOrganization(ctx, t.member.accessToken, "Their Own Co");

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const other = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${elsewhere.id}`)
        .set(authed(t.member.accessToken));
      expect(other.status).toBe(200);
      expect(other.body.data.role).toBe("owner");
    });

    it("restores every staff route on reactivation, with the same token", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "admin");
      const { conversationId } = await customerConversation(ctx, t.organization.id);

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });
      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "active" });

      const after = await staffProbes(ctx, t.organization.id, t.member.accessToken, conversationId);
      expect(after.context).toBe(200);
      expect(after.inbox).toBe(200);
      expect(after.roster).toBe(200);
      expect(after.claim).toBe(200);
    });

    it("restores the role that was there before, and no more", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx, "agent");

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });
      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "active" });

      const context = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${t.organization.id}`)
        .set(authed(t.member.accessToken));
      expect(context.body.data.role).toBe("agent");

      // An agent still holds no `member.read` — reactivation restores their
      // role, not a better one.
      const roster = await request(ctx.app).get(membersPath(t.organization.id)).set(authed(t.member.accessToken));
      expect(roster.status).toBe(403);
    });
  });

  // ==================== assignment cleanup ====================

  describe("assignment cleanup", () => {
    it("releases the suspended member's conversations and reports the count", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const first = await customerConversation(ctx, t.organization.id, "one@example.com");
      const second = await customerConversation(ctx, t.organization.id, "two@example.com");

      for (const { conversationId } of [first, second]) {
        const claim = await request(ctx.app)
          .patch(inboxPath(t.organization.id, `/${conversationId}/assignment`))
          .set(authed(t.member.accessToken))
          .send({ action: "claim" });
        expect(claim.status).toBe(200);
      }

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect(response.status).toBe(200);
      expect(response.body.data.releasedConversations).toBe(2);
      expect((await ConversationModel.findById(first.conversationId))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(second.conversationId))!.assignedTo).toBeNull();
    });

    it("preserves the conversations themselves", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { conversationId } = await customerConversation(ctx, t.organization.id);
      await request(ctx.app)
        .patch(inboxPath(t.organization.id, `/${conversationId}/assignment`))
        .set(authed(t.member.accessToken))
        .send({ action: "claim" });

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const stored = await ConversationModel.findById(conversationId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe("open");
      expect(await MessageModel.countDocuments({ conversationId })).toBeGreaterThan(0);
    });

    /* Another authorized agent sees it as unassigned and can claim it. */
    it("returns the conversation to the queue for other agents", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const colleague = await signedInStaff(ctx, "Colleague");
      await addMembership(colleague.userId, t.organization.id, "agent");
      const { conversationId } = await customerConversation(ctx, t.organization.id);

      await request(ctx.app)
        .patch(inboxPath(t.organization.id, `/${conversationId}/assignment`))
        .set(authed(t.member.accessToken))
        .send({ action: "claim" });

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const unassigned = await request(ctx.app)
        .get(inboxPath(t.organization.id, "?assignee=unassigned"))
        .set(authed(colleague.accessToken));
      expect(unassigned.status).toBe(200);
      expect(unassigned.body.data.conversations.map((c: { id: string }) => c.id)).toContain(conversationId);

      const claim = await request(ctx.app)
        .patch(inboxPath(t.organization.id, `/${conversationId}/assignment`))
        .set(authed(colleague.accessToken))
        .send({ action: "claim" });
      expect(claim.status).toBe(200);
    });

    /* ADR-029 §10: reactivation restores access and NOTHING else. */
    it("does not restore assignments on reactivation", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { conversationId } = await customerConversation(ctx, t.organization.id);

      await request(ctx.app)
        .patch(inboxPath(t.organization.id, `/${conversationId}/assignment`))
        .set(authed(t.member.accessToken))
        .send({ action: "claim" });
      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const reactivate = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "active" });

      expect(reactivate.status).toBe(200);
      expect(reactivate.body.data.releasedConversations).toBe(0);
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();

      // And the reactivated member's "assigned to me" queue is empty.
      const mine = await request(ctx.app)
        .get(inboxPath(t.organization.id, "?assignee=me"))
        .set(authed(t.member.accessToken));
      expect(mine.body.data.conversations).toHaveLength(0);
    });

    it("does not touch another tenant's assignments", async () => {
      const ctx = buildApp();
      const a = await tenantWithMember(ctx, "agent", "Org A");
      const b = await tenantWithMember(ctx, "agent", "Org B");
      const theirs = await customerConversation(ctx, b.organization.id, "bee@example.com");

      await request(ctx.app)
        .patch(inboxPath(b.organization.id, `/${theirs.conversationId}/assignment`))
        .set(authed(b.member.accessToken))
        .send({ action: "claim" });

      await request(ctx.app)
        .patch(statusPath(a.organization.id, a.membershipId))
        .set(authed(a.owner.accessToken))
        .send({ status: "suspended" });

      expect((await ConversationModel.findById(theirs.conversationId))!.assignedTo!.toString()).toBe(b.member.userId);
    });
  });

  // ==================== the customer boundary ====================

  describe("the customer surface is untouched", () => {
    it("keeps the customer's session, conversation, and messages working", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);
      const { conversationId, widgetToken } = await customerConversation(ctx, t.organization.id);

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const send = await request(ctx.app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "still here" });
      expect(send.status).toBe(201);

      const history = await request(ctx.app)
        .get(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`);
      expect(history.status).toBe(200);

      /*
        No membership state of any kind reaches a customer: the widget message
        projection is four fields, and none of them is a status or a role.
      */
      const keys = new Set(
        (history.body.data.messages as Record<string, unknown>[]).flatMap((m) => Object.keys(m)),
      );
      expect([...keys].sort()).toEqual(["attachments", "body", "conversationId", "createdAt", "id", "senderType"]);
      expect(JSON.stringify(history.body)).not.toContain("suspended");
      expect(JSON.stringify(history.body)).not.toContain(t.member.email);
    });
  });

  // ==================== rate limiting ====================

  describe("rate limiting (ADR-029 §11)", () => {
    /*
      The EXISTING `authenticatedWrite` class, shared with the role change and
      the removal — no new class, because this route discloses nothing a caller
      holding `member.read` cannot already fetch.
    */
    it("shares the authenticatedWrite budget with the sibling member writes", async () => {
      const setup = buildApp();
      const t = await tenantWithMember(setup, "agent");
      const limited = buildApp({ rateLimiting: true });

      // Spend the write budget on ROLE changes, then find the STATUS route
      // refused by the same counter.
      let lastRole = 0;
      for (let i = 0; i < AUTHENTICATED_WRITE_LIMIT; i += 1) {
        lastRole = (
          await request(limited.app)
            .patch(rolePath(t.organization.id, t.membershipId))
            .set(authed(t.owner.accessToken))
            .send({ role: i % 2 === 0 ? "supervisor" : "agent" })
        ).status;
      }
      expect(lastRole).toBe(200);

      const status = await request(limited.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      expect(status.status).toBe(429);
      expect(status.body.error.code).toBe("TOO_MANY_REQUESTS");
      expect(JSON.stringify(status.body)).not.toContain("authenticatedWrite");
    });
  });

  // ==================== response hygiene ====================

  describe("response hygiene", () => {
    it.each([
      ["unknown target", (_t: { membershipId: string; ownerMembershipId: string }) => UNKNOWN_ID],
      ["owner target", (t: { membershipId: string; ownerMembershipId: string }) => t.ownerMembershipId],
    ])("leaks nothing when refusing (%s)", async (_label, pick) => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const response = await request(ctx.app)
        .patch(statusPath(t.organization.id, pick(t)))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(t.owner.accessToken);
      expect(serialized).not.toContain(t.member.email);
      expect(serialized).not.toContain("reason");
      expect(serialized).not.toContain("invalid_transition");
      expect(serialized).not.toContain("owner_protected");
    });

    it("uses the standard envelopes", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      const ok = await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });
      expect(ok.body).toMatchObject({ success: true, data: expect.any(Object) });

      const refused = await request(ctx.app)
        .patch(statusPath(t.organization.id, UNKNOWN_ID))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });
      expect(refused.body).toMatchObject({
        success: false,
        error: { code: expect.any(String), message: expect.any(String), requestId: expect.any(String) },
      });
    });

    /* The roster renders a suspended row rather than hiding it (ADR-027 §14). */
    it("shows the suspended member on the roster, with their status", async () => {
      const ctx = buildApp();
      const t = await tenantWithMember(ctx);

      await request(ctx.app)
        .patch(statusPath(t.organization.id, t.membershipId))
        .set(authed(t.owner.accessToken))
        .send({ status: "suspended" });

      const roster = await request(ctx.app).get(membersPath(t.organization.id)).set(authed(t.owner.accessToken));
      const row = (roster.body.data.members as { id: string; status: string }[]).find((m) => m.id === t.membershipId);
      expect(row!.status).toBe("suspended");
    });
  });
});
