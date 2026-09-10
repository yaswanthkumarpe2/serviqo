import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { MEMBER_INVITE_LIMIT } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { ROLE_PERMISSIONS, can } from "../src/modules/memberships/permissions";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";

import type { MembershipRole, MembershipStatus } from "../src/modules/memberships/membership.model";

/**
 * Integration coverage for team management (ADR-027): the four member routes,
 * every authorization gate in front of them, the owner and self-modification
 * invariants, the duplicate rules, and the assignment cleanup that closes
 * ADR-026 §15.
 *
 * Real MongoDB, real Express, real credentials issued through the real
 * register → verify → login flow — no principal is stubbed, because the point
 * of most of these assertions is exactly which principal the server derives
 * and from where.
 *
 * The assertions that matter most and are invisible when broken:
 *
 * - A forged `organizationId`/`userId`/`role` in a body changes NOTHING,
 *   because the schema strips it before any handler runs (ADR-027 §4).
 * - An organization can never be left without an owner (§7a).
 * - Removing a member releases their conversations (§10) — the limitation
 *   ADR-026 §15 handed to this slice.
 * - A demoted admin is refused on their VERY NEXT request with the SAME token,
 *   because nothing caches a role (§11).
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

/** Obvious sentinels — if either reaches a response body or a log, the test fails. */
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
  const email = `member${emailCounter}@example.com`;

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

/** A registered account that never verified its email — §5's "may not be served". */
async function unverifiedStaff(ctx: Ctx, name = "Unverified Person") {
  emailCounter += 1;
  const email = `unverified${emailCounter}@example.com`;
  await request(ctx.app).post(REGISTER_PATH).send({ name, email, password: PASSWORD });
  return { email, name };
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

const membersPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/members${suffix}`;

const rolePath = (organizationId: string, membershipId: string) =>
  membersPath(organizationId, `/${membershipId}/role`);

const inboxPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/conversations${suffix}`;

const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

/**
 * An owner, their organization, and a second signed-in account already added
 * as an agent — the shape most of these tests need.
 */
async function tenantWithAgent(ctx: Ctx, organizationName = "Acme") {
  const owner = await signedInStaff(ctx, "Owner Person");
  const organization = await createOrganization(ctx, owner.accessToken, organizationName);
  const agent = await signedInStaff(ctx, "Agent Person");
  const membership = await addMembership(agent.userId, organization.id, "agent");

  return { owner, organization, agent, agentMembershipId: membership._id.toString() };
}

describe("team management", () => {
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

  // ---- reading the roster: member.read ----

  describe("GET /members — member.read", () => {
    it("returns the organization's roster to its owner", async () => {
      const ctx = buildApp();
      const { owner, organization, agent } = await tenantWithAgent(ctx);

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(owner.accessToken));

      expect(response.status).toBe(200);
      const members = response.body.data.members as { role: string; user: { id: string } }[];
      expect(members).toHaveLength(2);
      expect(members.map((m) => m.role)).toEqual(["owner", "agent"]);
      expect(members[0]!.user.id).toBe(owner.userId);
      expect(members[1]!.user.id).toBe(agent.userId);
    });

    it("projects membership id, role, status, and the member's identity", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(owner.accessToken));

      expect(response.body.data.members[0]).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f]{24}$/),
        role: "owner",
        status: "active",
        user: { id: owner.userId, name: owner.name, email: owner.email },
      });
    });

    it("discloses no authentication state — the roster is not an account dump", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(owner.accessToken));

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("failedLoginAttempts");
      expect(serialized).not.toContain("lockedUntil");
      expect(serialized).not.toContain("invitedByUserId");
      expect(serialized).not.toContain("organizationId");
    });

    it("lists invited and suspended memberships with their status visible", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);
      const invited = await signedInStaff(ctx, "Invited Person");
      const suspended = await signedInStaff(ctx, "Suspended Person");
      await addMembership(invited.userId, organization.id, "agent", "invited");
      await addMembership(suspended.userId, organization.id, "supervisor", "suspended");

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(owner.accessToken));

      const byUser = new Map(
        (response.body.data.members as { status: string; user: { id: string } }[]).map((m) => [m.user.id, m.status]),
      );
      expect(byUser.get(invited.userId)).toBe("invited");
      expect(byUser.get(suspended.userId)).toBe("suspended");
    });

    describe("role coverage", () => {
      /*
        Driven from `ROLE_PERMISSIONS` rather than from four hand-written
        cases, so a catalogue change cannot leave this suite asserting a table
        it no longer describes.
      */
      for (const role of Object.keys(ROLE_PERMISSIONS) as MembershipRole[]) {
        const allowed = can(role, "member.read");

        it(`${allowed ? "allows" : "refuses"} a ${role}`, async () => {
          const ctx = buildApp();
          const owner = await signedInStaff(ctx, "Owner Person");
          const organization = await createOrganization(ctx, owner.accessToken, "Acme");

          let accessToken = owner.accessToken;
          if (role !== "owner") {
            const staff = await signedInStaff(ctx, `${role} person`);
            await addMembership(staff.userId, organization.id, role);
            accessToken = staff.accessToken;
          }

          const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(accessToken));

          expect(response.status).toBe(allowed ? 200 : 403);
          if (!allowed) expect(response.body.error.code).toBe("INSUFFICIENT_PERMISSION");
        });
      }
    });

    it("refuses an unauthenticated request", async () => {
      const ctx = buildApp();
      const { organization } = await tenantWithAgent(ctx);

      const response = await request(ctx.app).get(membersPath(organization.id));

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("refuses a signed-in user who is not a member at all", async () => {
      const ctx = buildApp();
      const { organization } = await tenantWithAgent(ctx);
      const outsider = await signedInStaff(ctx, "Outsider");

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(outsider.accessToken));

      // 404, not 403 — a non-member must not learn the organization exists.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("refuses a suspended membership", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const suspended = await signedInStaff(ctx, "Suspended Admin");
      await addMembership(suspended.userId, organization.id, "admin", "suspended");

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(suspended.accessToken));

      expect(response.status).toBe(404);
    });

    it("refuses an invited (not yet accepted) membership", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const invited = await signedInStaff(ctx, "Invited Admin");
      await addMembership(invited.userId, organization.id, "admin", "invited");

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(invited.accessToken));

      expect(response.status).toBe(404);
    });

    it("refuses every member of a suspended organization", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);
      await OrganizationModel.updateOne({ _id: organization.id }, { $set: { status: "suspended" } });

      const response = await request(ctx.app).get(membersPath(organization.id)).set(authed(owner.accessToken));

      expect(response.status).toBe(404);
    });

    it("refuses a malformed organization id with the same opaque 404", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);

      const response = await request(ctx.app).get(membersPath("not-an-id")).set(authed(owner.accessToken));

      expect(response.status).toBe(404);
    });
  });

  // ---- adding a member: member.manage ----

  describe("POST /members — member.manage", () => {
    it("adds an existing verified account as an active member", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: newcomer.email, role: "agent" });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        role: "agent",
        status: "active",
        user: { id: newcomer.userId, email: newcomer.email },
      });

      const stored = await MembershipModel.findOne({ userId: newcomer.userId, organizationId: organization.id });
      expect(stored!.status).toBe("active");
      expect(stored!.role).toBe("agent");
    });

    it("records the ACTING user as invitedByUserId, from the token and never the body", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const newcomer = await signedInStaff(ctx, "Newcomer");
      const impostor = await signedInStaff(ctx, "Impostor");

      await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: newcomer.email, role: "agent", invitedByUserId: impostor.userId });

      const stored = await MembershipModel.findOne({ userId: newcomer.userId, organizationId: organization.id });
      expect(stored!.invitedByUserId!.toString()).toBe(owner.userId);
    });

    it("normalizes the email, so casing cannot create a second membership", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: `  ${newcomer.email.toUpperCase()}  `, role: "agent" });

      expect(response.status).toBe(201);
      expect(await MembershipModel.countDocuments({ organizationId: organization.id })).toBe(2);
    });

    it("accepts every assignable role in the catalogue", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");

      for (const role of ["admin", "supervisor", "agent"] as const) {
        const newcomer = await signedInStaff(ctx, `${role} newcomer`);
        const response = await request(ctx.app)
          .post(membersPath(organization.id))
          .set(authed(owner.accessToken))
          .send({ email: newcomer.email, role });

        expect(response.status).toBe(201);
        expect(response.body.data.role).toBe(role);
      }
    });

    it("refuses role: owner — granting ownership is transfer, not a role write", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: newcomer.email, role: "owner" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      // And the one-owner invariant is untouched.
      expect(await MembershipModel.countDocuments({ organizationId: organization.id, role: "owner" })).toBe(1);
    });

    it("refuses an invalid role", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      for (const role of ["superuser", "customer", "", 42, null]) {
        const response = await request(ctx.app)
          .post(membersPath(organization.id))
          .set(authed(owner.accessToken))
          .send({ email: newcomer.email, role });

        expect(response.status).toBe(400);
      }
    });

    it("refuses a duplicate membership and creates no second row", async () => {
      const ctx = buildApp();
      const { owner, organization, agent } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: agent.email, role: "admin" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_ALREADY_EXISTS");
      expect(await MembershipModel.countDocuments({ userId: agent.userId, organizationId: organization.id })).toBe(1);
      // And the existing role was not quietly changed.
      const stored = await MembershipModel.findOne({ userId: agent.userId, organizationId: organization.id });
      expect(stored!.role).toBe("agent");
    });

    it("treats an invited membership as already a member", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const pending = await signedInStaff(ctx, "Pending Person");
      await addMembership(pending.userId, organization.id, "agent", "invited");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: pending.email, role: "agent" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_ALREADY_EXISTS");
    });

    it("treats a suspended membership as already a member — re-adding is not reinstatement", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const suspended = await signedInStaff(ctx, "Suspended Person");
      await addMembership(suspended.userId, organization.id, "agent", "suspended");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: suspended.email, role: "agent" });

      expect(response.status).toBe(409);
      const stored = await MembershipModel.findOne({ userId: suspended.userId, organizationId: organization.id });
      expect(stored!.status).toBe("suspended");
    });

    it("refuses the owner adding themselves again", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: owner.email, role: "agent" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_ALREADY_EXISTS");
      expect(await MembershipModel.countDocuments({ organizationId: organization.id, role: "owner" })).toBe(1);
    });

    it("refuses an email with no Serviqo account", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: "nobody-at-all@example.com", role: "agent" });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("MEMBER_NOT_INVITABLE");
      expect(await MembershipModel.countDocuments({ organizationId: organization.id })).toBe(1);
    });

    it("refuses an unverified account with the BYTE-IDENTICAL refusal an unknown email gets", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const unverified = await unverifiedStaff(ctx);

      const unknown = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: "nobody-at-all@example.com", role: "agent" });

      const notEntitled = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: unverified.email, role: "agent" });

      expect(notEntitled.status).toBe(unknown.status);
      expect(notEntitled.body.error.code).toBe(unknown.body.error.code);
      // The wording is what an attacker reads, and it must not differ.
      expect(notEntitled.body.error.message).toBe(unknown.body.error.message);
    });

    it("refuses a disabled account with the same refusal", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const disabled = await signedInStaff(ctx, "Disabled Person");
      await UserModel.updateOne({ _id: disabled.userId }, { $set: { status: "disabled" } });

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: disabled.email, role: "agent" });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("MEMBER_NOT_INVITABLE");
    });

    it("refuses a malformed email before any lookup", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: "not-an-email", role: "agent" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    describe("role coverage", () => {
      for (const role of Object.keys(ROLE_PERMISSIONS) as MembershipRole[]) {
        const allowed = can(role, "member.manage");

        it(`${allowed ? "allows" : "refuses"} a ${role}`, async () => {
          const ctx = buildApp();
          const owner = await signedInStaff(ctx, "Owner Person");
          const organization = await createOrganization(ctx, owner.accessToken, "Acme");
          const newcomer = await signedInStaff(ctx, "Newcomer");

          let accessToken = owner.accessToken;
          if (role !== "owner") {
            const staff = await signedInStaff(ctx, `${role} person`);
            await addMembership(staff.userId, organization.id, role);
            accessToken = staff.accessToken;
          }

          const response = await request(ctx.app)
            .post(membersPath(organization.id))
            .set(authed(accessToken))
            .send({ email: newcomer.email, role: "agent" });

          expect(response.status).toBe(allowed ? 201 : 403);
          if (!allowed) {
            expect(response.body.error.code).toBe("INSUFFICIENT_PERMISSION");
            expect(await MembershipModel.findOne({ userId: newcomer.userId })).toBeNull();
          }
        });
      }
    });

    it("refuses a supervisor specifically — member.read is not member.manage", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const supervisor = await signedInStaff(ctx, "Supervisor");
      await addMembership(supervisor.userId, organization.id, "supervisor");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      // They CAN read the roster …
      expect((await request(ctx.app).get(membersPath(organization.id)).set(authed(supervisor.accessToken))).status).toBe(
        200,
      );

      // … and they cannot change it.
      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(supervisor.accessToken))
        .send({ email: newcomer.email, role: "agent" });

      expect(response.status).toBe(403);
    });
  });

  // ---- changing a role ----

  describe("PATCH /members/:membershipId/role", () => {
    it("changes a member's role", async () => {
      const ctx = buildApp();
      const { owner, organization, agentMembershipId } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, agentMembershipId))
        .set(authed(owner.accessToken))
        .send({ role: "supervisor" });

      expect(response.status).toBe(200);
      expect(response.body.data.role).toBe("supervisor");
      expect((await MembershipModel.findById(agentMembershipId))!.role).toBe("supervisor");
    });

    it("takes effect on the target's VERY NEXT request, with the same access token", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const staff = await signedInStaff(ctx, "Promoted Person");
      const membership = await addMembership(staff.userId, organization.id, "admin");

      // As an admin they can read the roster.
      expect((await request(ctx.app).get(membersPath(organization.id)).set(authed(staff.accessToken))).status).toBe(200);

      await request(ctx.app)
        .patch(rolePath(organization.id, membership._id.toString()))
        .set(authed(owner.accessToken))
        .send({ role: "agent" });

      // Same token, next request, new role — nothing caches it (ADR-027 §11).
      const after = await request(ctx.app).get(membersPath(organization.id)).set(authed(staff.accessToken));
      expect(after.status).toBe(403);
      expect(after.body.error.code).toBe("INSUFFICIENT_PERMISSION");
    });

    it("revokes a previously authorized WRITE the moment the role loses member.manage", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const admin = await signedInStaff(ctx, "Demoted Admin");
      const adminMembership = await addMembership(admin.userId, organization.id, "admin");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      await request(ctx.app)
        .patch(rolePath(organization.id, adminMembership._id.toString()))
        .set(authed(owner.accessToken))
        .send({ role: "agent" });

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(admin.accessToken))
        .send({ email: newcomer.email, role: "agent" });

      expect(response.status).toBe(403);
    });

    it("refuses demoting the owner — an organization is never left without one", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const admin = await signedInStaff(ctx, "Admin Person");
      await addMembership(admin.userId, organization.id, "admin");
      const ownerMembership = await MembershipModel.findOne({ organizationId: organization.id, role: "owner" });

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, ownerMembership!._id.toString()))
        .set(authed(admin.accessToken))
        .send({ role: "agent" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ORGANIZATION_OWNER_PROTECTED");
      expect((await MembershipModel.findById(ownerMembership!._id))!.role).toBe("owner");
      expect(await MembershipModel.countDocuments({ organizationId: organization.id, role: "owner" })).toBe(1);
    });

    it("refuses the owner demoting themselves", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const ownerMembership = await MembershipModel.findOne({ organizationId: organization.id, role: "owner" });

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, ownerMembership!._id.toString()))
        .set(authed(owner.accessToken))
        .send({ role: "admin" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ORGANIZATION_OWNER_PROTECTED");
    });

    it("refuses an admin changing their own role", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const admin = await signedInStaff(ctx, "Admin Person");
      const membership = await addMembership(admin.userId, organization.id, "admin");

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, membership._id.toString()))
        .set(authed(admin.accessToken))
        .send({ role: "supervisor" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_SELF_MODIFICATION");
      expect((await MembershipModel.findById(membership._id))!.role).toBe("admin");
    });

    it("refuses promotion to owner at the schema, so the one-owner index is never reached", async () => {
      const ctx = buildApp();
      const { owner, organization, agentMembershipId } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, agentMembershipId))
        .set(authed(owner.accessToken))
        .send({ role: "owner" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await MembershipModel.countDocuments({ organizationId: organization.id, role: "owner" })).toBe(1);
    });

    it("lets an admin change another admin's role — the catalogue says member.manage and nothing about targets", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const actor = await signedInStaff(ctx, "Acting Admin");
      const target = await signedInStaff(ctx, "Target Admin");
      await addMembership(actor.userId, organization.id, "admin");
      const targetMembership = await addMembership(target.userId, organization.id, "admin");

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, targetMembership._id.toString()))
        .set(authed(actor.accessToken))
        .send({ role: "agent" });

      expect(response.status).toBe(200);
    });

    describe("role coverage", () => {
      for (const role of Object.keys(ROLE_PERMISSIONS) as MembershipRole[]) {
        if (role === "owner") continue;
        const allowed = can(role, "member.manage");

        it(`${allowed ? "allows" : "refuses"} a ${role}`, async () => {
          const ctx = buildApp();
          const { owner, organization, agentMembershipId } = await tenantWithAgent(ctx);
          const actor = await signedInStaff(ctx, `${role} actor`);
          await addMembership(actor.userId, organization.id, role);
          expect(owner.userId).toBeDefined();

          const response = await request(ctx.app)
            .patch(rolePath(organization.id, agentMembershipId))
            .set(authed(actor.accessToken))
            .send({ role: "supervisor" });

          expect(response.status).toBe(allowed ? 200 : 403);
        });
      }
    });

    it("refuses a malformed membership id with a 400 before any query", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, "not-an-id"))
        .set(authed(owner.accessToken))
        .send({ role: "agent" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("refuses a well-formed membership id belonging to nothing", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .patch(rolePath(organization.id, UNKNOWN_ID))
        .set(authed(owner.accessToken))
        .send({ role: "agent" });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  // ---- removing a member ----

  describe("DELETE /members/:membershipId", () => {
    it("removes the membership and reports what was removed", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.member).toMatchObject({ id: agentMembershipId, role: "agent" });
      expect(response.body.data.releasedConversations).toBe(0);
      expect(await MembershipModel.findById(agentMembershipId)).toBeNull();
      expect(await UserModel.findById(agent.userId)).not.toBeNull(); // The person still exists.
    });

    it("revokes the removed member's access on their VERY NEXT request", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);

      expect((await request(ctx.app).get(inboxPath(organization.id)).set(authed(agent.accessToken))).status).toBe(200);

      await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      const after = await request(ctx.app).get(inboxPath(organization.id)).set(authed(agent.accessToken));
      expect(after.status).toBe(404);
    });

    it("refuses removing the owner", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const admin = await signedInStaff(ctx, "Admin Person");
      await addMembership(admin.userId, organization.id, "admin");
      const ownerMembership = await MembershipModel.findOne({ organizationId: organization.id, role: "owner" });

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${ownerMembership!._id.toString()}`))
        .set(authed(admin.accessToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ORGANIZATION_OWNER_PROTECTED");
      expect(await MembershipModel.countDocuments({ organizationId: organization.id, role: "owner" })).toBe(1);
    });

    it("refuses the owner removing themselves, so the tenant keeps an owner", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const ownerMembership = await MembershipModel.findOne({ organizationId: organization.id, role: "owner" });

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${ownerMembership!._id.toString()}`))
        .set(authed(owner.accessToken));

      expect(response.status).toBe(409);
      expect(await MembershipModel.countDocuments({ organizationId: organization.id, role: "owner" })).toBe(1);
    });

    it("refuses an admin removing themselves", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const admin = await signedInStaff(ctx, "Admin Person");
      const membership = await addMembership(admin.userId, organization.id, "admin");

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${membership._id.toString()}`))
        .set(authed(admin.accessToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("MEMBER_SELF_MODIFICATION");
      expect(await MembershipModel.findById(membership._id)).not.toBeNull();
    });

    it("removes a suspended member", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const suspended = await signedInStaff(ctx, "Suspended Person");
      const membership = await addMembership(suspended.userId, organization.id, "agent", "suspended");

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${membership._id.toString()}`))
        .set(authed(owner.accessToken));

      expect(response.status).toBe(200);
      expect(await MembershipModel.findById(membership._id)).toBeNull();
    });

    describe("role coverage", () => {
      for (const role of Object.keys(ROLE_PERMISSIONS) as MembershipRole[]) {
        if (role === "owner") continue;
        const allowed = can(role, "member.manage");

        it(`${allowed ? "allows" : "refuses"} a ${role}`, async () => {
          const ctx = buildApp();
          const { organization, agentMembershipId } = await tenantWithAgent(ctx);
          const actor = await signedInStaff(ctx, `${role} actor`);
          await addMembership(actor.userId, organization.id, role);

          const response = await request(ctx.app)
            .delete(membersPath(organization.id, `/${agentMembershipId}`))
            .set(authed(actor.accessToken));

          expect(response.status).toBe(allowed ? 200 : 403);
          if (!allowed) expect(await MembershipModel.findById(agentMembershipId)).not.toBeNull();
        });
      }
    });

    it("refuses a malformed membership id", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, "/not-an-id"))
        .set(authed(owner.accessToken));

      expect(response.status).toBe(400);
    });

    it("refuses a well-formed membership id belonging to nothing", async () => {
      const ctx = buildApp();
      const { owner, organization } = await tenantWithAgent(ctx);

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${UNKNOWN_ID}`))
        .set(authed(owner.accessToken));

      expect(response.status).toBe(404);
    });
  });

  // ---- assignment cleanup: ADR-026 §15's carried-forward limitation, closed ----

  describe("assignment cleanup on removal (ADR-027 §10)", () => {
    it("releases every conversation the removed member held", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const first = await customerConversation(ctx, organization.id, "one@example.com");
      const second = await customerConversation(ctx, organization.id, "two@example.com");

      for (const { conversationId } of [first, second]) {
        await request(ctx.app)
          .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
          .set(authed(agent.accessToken))
          .send({ action: "claim" });
      }

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.releasedConversations).toBe(2);

      for (const { conversationId } of [first, second]) {
        expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
      }
    });

    it("leaves no stale assignment pointing at an inaccessible account", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      // No conversation in this tenant points at the departed user any more.
      expect(await ConversationModel.countDocuments({ organizationId: organization.id, assignedTo: agent.userId })).toBe(
        0,
      );
    });

    it("makes the released conversation visible to another agent as unassigned", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const other = await signedInStaff(ctx, "Other Agent");
      await addMembership(other.userId, organization.id, "agent");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      // Before removal it is somebody else's.
      const before = await request(ctx.app)
        .get(inboxPath(organization.id, "?assignee=unassigned"))
        .set(authed(other.accessToken));
      expect(before.body.data.conversations).toHaveLength(0);

      await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      const after = await request(ctx.app)
        .get(inboxPath(organization.id, "?assignee=unassigned"))
        .set(authed(other.accessToken));
      expect(after.body.data.conversations).toHaveLength(1);
      expect(after.body.data.conversations[0].id).toBe(conversationId);
      expect(after.body.data.conversations[0].assignedTo).toBeNull();

      // And the other agent can now claim it, which they could not before.
      const claim = await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(other.accessToken))
        .send({ action: "claim" });
      expect(claim.status).toBe(200);
      expect(claim.body.data.assignedTo.id).toBe(other.userId);
    });

    it("leaves another agent's assignments untouched", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const other = await signedInStaff(ctx, "Other Agent");
      await addMembership(other.userId, organization.id, "agent");

      const mine = await customerConversation(ctx, organization.id, "mine@example.com");
      const theirs = await customerConversation(ctx, organization.id, "theirs@example.com");

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${mine.conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });
      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${theirs.conversationId}/assignment`))
        .set(authed(other.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(response.body.data.releasedConversations).toBe(1);
      expect((await ConversationModel.findById(theirs.conversationId))!.assignedTo!.toString()).toBe(other.userId);
    });

    it("does not release the removed member's work in a DIFFERENT organization", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const orgA = await createOrganization(ctx, owner.accessToken, "Acme A");
      const otherOwner = await signedInStaff(ctx, "Other Owner");
      const orgB = await createOrganization(ctx, otherOwner.accessToken, "Acme B");

      const agent = await signedInStaff(ctx, "Dual Agent");
      const inA = await addMembership(agent.userId, orgA.id, "agent");
      await addMembership(agent.userId, orgB.id, "agent");

      const convA = await customerConversation(ctx, orgA.id, "a@example.com");
      const convB = await customerConversation(ctx, orgB.id, "b@example.com");

      for (const [org, conv] of [
        [orgA.id, convA.conversationId],
        [orgB.id, convB.conversationId],
      ] as const) {
        await request(ctx.app)
          .patch(inboxPath(org, `/${conv}/assignment`))
          .set(authed(agent.accessToken))
          .send({ action: "claim" });
      }

      await request(ctx.app)
        .delete(membersPath(orgA.id, `/${inA._id.toString()}`))
        .set(authed(owner.accessToken));

      expect((await ConversationModel.findById(convA.conversationId))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(convB.conversationId))!.assignedTo!.toString()).toBe(agent.userId);
    });

    it("releases closed conversations too", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });
      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/status`))
        .set(authed(agent.accessToken))
        .send({ status: "closed" });

      const response = await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(response.body.data.releasedConversations).toBe(1);
      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo).toBeNull();
      expect(stored!.status).toBe("closed");
    });

    /*
      ADR-027 §10's premise. Every role in today's catalogue holds
      `conversation.assign`, so a role change must leave assignments ALONE.
      The guard exists for a future read-only role; this asserts the state of
      the world it guards against, and fails loudly if the table changes.
    */
    it("leaves assignments intact on a role change, because every current role holds conversation.assign", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      for (const role of ["supervisor", "admin", "agent"] as const) {
        expect(can(role, "conversation.assign")).toBe(true);

        await request(ctx.app)
          .patch(rolePath(organization.id, agentMembershipId))
          .set(authed(owner.accessToken))
          .send({ role });

        expect((await ConversationModel.findById(conversationId))!.assignedTo!.toString()).toBe(agent.userId);
      }
    });

    it("keeps the promoted member able to work their existing queue", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      await request(ctx.app)
        .patch(rolePath(organization.id, agentMembershipId))
        .set(authed(owner.accessToken))
        .send({ role: "supervisor" });

      const release = await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "release" });

      expect(release.status).toBe(200);
      expect(release.body.data.assignedTo).toBeNull();
    });
  });

  // ---- the agent inbox's own view of the roster ----

  describe("Agent Inbox visibility", () => {
    it("shows the assignee's NAME to a reader who holds member.read", async () => {
      const ctx = buildApp();
      const { owner, organization, agent } = await tenantWithAgent(ctx);
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(owner.accessToken));

      expect(response.body.data.conversations[0].assignedTo).toEqual({ id: agent.userId, name: agent.name });
    });

    it("withholds the name from an agent, who does not hold member.read", async () => {
      const ctx = buildApp();
      const { organization, agent } = await tenantWithAgent(ctx);
      const other = await signedInStaff(ctx, "Other Agent");
      await addMembership(other.userId, organization.id, "agent");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(other.accessToken));

      expect(response.body.data.conversations[0].assignedTo).toEqual({ id: agent.userId, name: null });
    });

    it("stops rendering a removed member's name, because the conversation is unassigned", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(owner.accessToken));

      expect(response.body.data.conversations[0].assignedTo).toBeNull();
      expect(JSON.stringify(response.body)).not.toContain(agent.name);
    });
  });

  // ---- tenant isolation and forged identity ----

  describe("cross-organization isolation", () => {
    async function twoTenants(ctx: Ctx) {
      const ownerA = await signedInStaff(ctx, "Owner A");
      const orgA = await createOrganization(ctx, ownerA.accessToken, "Acme A");
      const ownerB = await signedInStaff(ctx, "Owner B");
      const orgB = await createOrganization(ctx, ownerB.accessToken, "Acme B");

      const agentB = await signedInStaff(ctx, "Agent B");
      const membershipB = await addMembership(agentB.userId, orgB.id, "agent");

      return { ownerA, orgA, ownerB, orgB, agentB, membershipB: membershipB._id.toString() };
    }

    it("refuses organization A's owner reading organization B's roster", async () => {
      const ctx = buildApp();
      const { ownerA, orgB } = await twoTenants(ctx);

      const response = await request(ctx.app).get(membersPath(orgB.id)).set(authed(ownerA.accessToken));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("refuses organization A's owner adding a member to organization B", async () => {
      const ctx = buildApp();
      const { ownerA, orgB } = await twoTenants(ctx);
      const newcomer = await signedInStaff(ctx, "Newcomer");

      const response = await request(ctx.app)
        .post(membersPath(orgB.id))
        .set(authed(ownerA.accessToken))
        .send({ email: newcomer.email, role: "agent" });

      expect(response.status).toBe(404);
      expect(await MembershipModel.findOne({ userId: newcomer.userId })).toBeNull();
    });

    it("refuses reaching another tenant's membership through the caller's OWN organization path", async () => {
      const ctx = buildApp();
      const { ownerA, orgA, membershipB } = await twoTenants(ctx);

      // The caller is a legitimate owner of orgA, and names orgA in the URL —
      // only the membership belongs elsewhere. The query takes both keys, so
      // it is not located rather than being located and refused.
      const response = await request(ctx.app)
        .patch(rolePath(orgA.id, membershipB))
        .set(authed(ownerA.accessToken))
        .send({ role: "admin" });

      expect(response.status).toBe(404);
      expect((await MembershipModel.findById(membershipB))!.role).toBe("agent");
    });

    it("refuses removing another tenant's membership through the caller's own organization path", async () => {
      const ctx = buildApp();
      const { ownerA, orgA, membershipB } = await twoTenants(ctx);

      const response = await request(ctx.app)
        .delete(membersPath(orgA.id, `/${membershipB}`))
        .set(authed(ownerA.accessToken));

      expect(response.status).toBe(404);
      expect(await MembershipModel.findById(membershipB)).not.toBeNull();
    });

    it("answers a cross-tenant membership and a nonexistent one identically", async () => {
      const ctx = buildApp();
      const { ownerA, orgA, membershipB } = await twoTenants(ctx);

      const crossTenant = await request(ctx.app)
        .delete(membersPath(orgA.id, `/${membershipB}`))
        .set(authed(ownerA.accessToken));
      const nonexistent = await request(ctx.app)
        .delete(membersPath(orgA.id, `/${UNKNOWN_ID}`))
        .set(authed(ownerA.accessToken));

      expect(crossTenant.status).toBe(nonexistent.status);
      expect(crossTenant.body.error.code).toBe(nonexistent.body.error.code);
      expect(crossTenant.body.error.message).toBe(nonexistent.body.error.message);
    });

    it("answers an unreachable organization and a nonexistent one identically", async () => {
      const ctx = buildApp();
      const { ownerA, orgB } = await twoTenants(ctx);

      const otherTenant = await request(ctx.app).get(membersPath(orgB.id)).set(authed(ownerA.accessToken));
      const nonexistent = await request(ctx.app).get(membersPath(UNKNOWN_ID)).set(authed(ownerA.accessToken));

      expect(otherTenant.status).toBe(nonexistent.status);
      expect(otherTenant.body.error.code).toBe(nonexistent.body.error.code);
      expect(otherTenant.body.error.message).toBe(nonexistent.body.error.message);
    });
  });

  describe("forged request identity", () => {
    it("ignores a forged organizationId in the body — the path is the only source", async () => {
      const ctx = buildApp();
      const ownerA = await signedInStaff(ctx, "Owner A");
      const orgA = await createOrganization(ctx, ownerA.accessToken, "Acme A");
      const ownerB = await signedInStaff(ctx, "Owner B");
      const orgB = await createOrganization(ctx, ownerB.accessToken, "Acme B");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      const response = await request(ctx.app)
        .post(membersPath(orgA.id))
        .set(authed(ownerA.accessToken))
        .send({ email: newcomer.email, role: "agent", organizationId: orgB.id });

      expect(response.status).toBe(201);
      // It landed in the tenant the PATH named, not the one the body did.
      expect(await MembershipModel.findOne({ userId: newcomer.userId, organizationId: orgB.id })).toBeNull();
      expect(await MembershipModel.findOne({ userId: newcomer.userId, organizationId: orgA.id })).not.toBeNull();
    });

    it("ignores a forged organizationId in the query string", async () => {
      const ctx = buildApp();
      const ownerA = await signedInStaff(ctx, "Owner A");
      const orgA = await createOrganization(ctx, ownerA.accessToken, "Acme A");
      const ownerB = await signedInStaff(ctx, "Owner B");
      const orgB = await createOrganization(ctx, ownerB.accessToken, "Acme B");

      const response = await request(ctx.app)
        .get(`${membersPath(orgA.id)}?organizationId=${orgB.id}`)
        .set(authed(ownerA.accessToken));

      expect(response.status).toBe(200);
      const emails = (response.body.data.members as { user: { email: string } }[]).map((m) => m.user.email);
      expect(emails).toEqual([ownerA.email]);
      expect(emails).not.toContain(ownerB.email);
    });

    it("ignores a forged userId in the body — the target comes from the path", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const bystander = await signedInStaff(ctx, "Bystander");
      const bystanderMembership = await addMembership(bystander.userId, organization.id, "agent");

      await request(ctx.app)
        .patch(rolePath(organization.id, agentMembershipId))
        .set(authed(owner.accessToken))
        .send({ role: "supervisor", userId: bystander.userId, membershipId: bystanderMembership._id.toString() });

      expect((await MembershipModel.findById(agentMembershipId))!.role).toBe("supervisor");
      expect((await MembershipModel.findById(bystanderMembership._id))!.role).toBe("agent");
      expect(agent.userId).toBeDefined();
    });

    it("ignores a forged role in the body of an add — only `role` is read, and only from the schema", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const newcomer = await signedInStaff(ctx, "Newcomer");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: newcomer.email, role: "agent", status: "suspended", membershipRole: "owner" });

      expect(response.status).toBe(201);
      const stored = await MembershipModel.findOne({ userId: newcomer.userId, organizationId: organization.id });
      expect(stored!.role).toBe("agent");
      // `status` was stripped, so the literal "active" the service writes stands.
      expect(stored!.status).toBe("active");
    });

    it("cannot escalate itself: an agent forging a role in the body is still refused by the permission gate", async () => {
      const ctx = buildApp();
      const { organization, agent } = await tenantWithAgent(ctx);
      const newcomer = await signedInStaff(ctx, "Newcomer");

      const response = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(agent.accessToken))
        .send({ email: newcomer.email, role: "agent", actingRole: "owner", role_: "owner" });

      expect(response.status).toBe(403);
    });
  });

  // ---- rate limiting ----

  describe("rate limiting", () => {
    it("bounds the add route with its own class", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");

      let refused: request.Response | null = null;

      for (let attempt = 0; attempt < MEMBER_INVITE_LIMIT + 1; attempt += 1) {
        const response = await request(ctx.app)
          .post(membersPath(organization.id))
          .set(authed(owner.accessToken))
          .send({ email: `probe-${attempt}@example.com`, role: "agent" });

        if (response.status === 429) {
          refused = response;
          break;
        }
      }

      expect(refused).not.toBeNull();
      expect(refused!.body.error.code).toBe("TOO_MANY_REQUESTS");
      // The class that refused is never named to the caller (ADR-018 §6).
      expect(JSON.stringify(refused!.body)).not.toContain("memberInvite");
    });

    it("does not spend the invite budget on ordinary reads", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const owner = await signedInStaff(ctx, "Owner Person");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");

      for (let attempt = 0; attempt < MEMBER_INVITE_LIMIT + 5; attempt += 1) {
        expect((await request(ctx.app).get(membersPath(organization.id)).set(authed(owner.accessToken))).status).toBe(
          200,
        );
      }

      const newcomer = await signedInStaff(ctx, "Newcomer");
      const add = await request(ctx.app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: newcomer.email, role: "agent" });

      expect(add.status).toBe(201);
    });
  });

  // ---- existing behaviour must keep working ----

  describe("existing surfaces are unaffected", () => {
    it("leaves the customer widget session, conversation, and messages working", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));
      expect(agent.userId).toBeDefined();

      const send = await request(ctx.app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "still working" });

      expect(send.status).toBe(201);

      const history = await request(ctx.app)
        .get(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`);

      expect(history.status).toBe(200);
      expect(history.body.data.messages.length).toBeGreaterThanOrEqual(2);
    });

    it("never exposes staff roster data to a customer", async () => {
      const ctx = buildApp();
      const { organization, agent } = await tenantWithAgent(ctx);
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const conversation = await request(ctx.app)
        .get(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`);

      const serialized = JSON.stringify(conversation.body);
      expect(serialized).not.toContain(agent.name);
      expect(serialized).not.toContain(agent.email);
      expect(serialized).not.toContain(agent.userId);
      expect(serialized).not.toContain("assignedTo");
    });

    it("refuses a customer's widget token on every member route", async () => {
      const ctx = buildApp();
      const { organization } = await tenantWithAgent(ctx);
      const { widgetToken } = await customerConversation(ctx, organization.id);

      const list = await request(ctx.app)
        .get(membersPath(organization.id))
        .set("Authorization", `Bearer ${widgetToken}`);

      // A widget token is signed with a different secret and carries a
      // different audience, so it never verifies as a staff access token.
      expect(list.status).toBe(401);
      expect(list.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("drops the organization from the removed member's /me", async () => {
      const ctx = buildApp();
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent(ctx);

      const before = await request(ctx.app).get("/api/v1/auth/me").set(authed(agent.accessToken));
      expect(before.body.data.memberships).toHaveLength(1);

      await request(ctx.app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      const after = await request(ctx.app).get("/api/v1/auth/me").set(authed(agent.accessToken));
      // They are still a signed-in Serviqo user, with one fewer organization.
      expect(after.status).toBe(200);
      expect(after.body.data.memberships).toHaveLength(0);
    });
  });
});
