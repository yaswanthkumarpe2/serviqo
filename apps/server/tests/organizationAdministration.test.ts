import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

import type { EmailProvider } from "../src/lib/email/emailProvider";

/**
 * Super admin → organisations → org admins → agents (ADR-039).
 *
 * The super admin creates organisations and invites their owners; an
 * organisation's admins invite their own team; and the super admin can step
 * into any organisation. The refusals are the point: nobody below the super
 * admin creates organisations, and nobody reaches an organisation they were not
 * put into.
 */

const LOGIN_PATH = "/api/v1/auth/login";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const ADMIN_ORGANIZATIONS_PATH = "/api/v1/admin/organizations";
const SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const SUPER_ADMIN_EMAIL = "operator@example.com";

type Ctx = ReturnType<typeof buildApp>;

function buildApp(emailProvider?: EmailProvider) {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: emailProvider ?? fake.provider }) };
}

async function verifiedStaff(ctx: Ctx, email: string, name = "Ada Lovelace") {
  await createStaffAccount(ctx.fake.provider, { name, email, password: PASSWORD });
  await request(ctx.app).post(VERIFY_PATH).send({ email, code: ctx.fake.verifications.at(-1)!.code });
}

async function signIn(ctx: Ctx, email: string, password = PASSWORD): Promise<string> {
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password });
  return login.body.data.accessToken as string;
}

async function superAdminToken(ctx: Ctx): Promise<string> {
  await verifiedStaff(ctx, SUPER_ADMIN_EMAIL, "Grace Hopper");
  await UserModel.updateOne({ email: SUPER_ADMIN_EMAIL }, { $set: { platformRole: "admin", kind: "admin" } });
  return signIn(ctx, SUPER_ADMIN_EMAIL);
}

const as = (ctx: Ctx, token: string) => ({
  get: (path: string) => request(ctx.app).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(ctx.app).post(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(ctx.app).patch(path).set("Authorization", `Bearer ${token}`),
});

async function createOrganization(ctx: Ctx, adminToken: string, name: string, ownerEmail: string) {
  const response = await as(ctx, adminToken)
    .post(ADMIN_ORGANIZATIONS_PATH)
    .send({ name, owner: { name: "Olivia Owner", email: ownerEmail } });
  expect(response.status).toBe(201);
  return response.body.data as {
    organization: { id: string; name: string; slug: string; widgetUrl: string; status: string };
    owner: { userId: string; email: string; role: string; verified: boolean };
    accountCreated: boolean;
  };
}

/** Verifies and signs in someone whose credentials the fake provider captured. */
async function acceptInvitation(ctx: Ctx, email: string): Promise<string> {
  const mail = ctx.fake.agentCredentials.filter((entry) => entry.to === email).at(-1)!;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code: mail.code });
  return signIn(ctx, email, mail.temporaryPassword);
}

/** A customer writing to an organisation through its widget. */
async function customerConversation(ctx: Ctx, organizationId: string) {
  const organization = await OrganizationModel.findById(organizationId);
  const session = await request(ctx.app).post(SESSION_PATH).send({ widgetKey: organization!.widgetKey });
  const token = session.body.data.token as string;
  const conversation = await request(ctx.app)
    .post(WIDGET_CONVERSATIONS_PATH)
    .set("Authorization", `Bearer ${token}`)
    .send({});
  const conversationId = conversation.body.data.id as string;
  await request(ctx.app)
    .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
    .set("Authorization", `Bearer ${token}`)
    .send({ body: "Where is my order?" });
  return conversationId;
}

describe("organisation administration", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      UserModel.init(),
      AccountTokenModel.init(),
      SessionModel.init(),
      OrganizationModel.init(),
      MembershipModel.init(),
      CustomerModel.init(),
      ConversationModel.init(),
      MessageModel.init(),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
      SessionModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- creating organisations ----

  describe("the super admin creating an organisation", () => {
    it("creates it with a slug, a widget link, and a new owner who is emailed credentials", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);

      const result = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");

      expect(result.organization).toMatchObject({
        name: "CentralService",
        slug: "centralservice",
        status: "active",
        widgetUrl: "http://localhost:5173/widget/centralservice",
      });
      expect(result.owner).toMatchObject({ email: "olivia@central.test", role: "owner", verified: false });
      expect(result.accountCreated).toBe(true);

      const mail = ctx.fake.agentCredentials.at(-1)!;
      expect(mail.to).toBe("olivia@central.test");
      expect(mail.organizationName).toBe("CentralService");
      expect(mail.roleLabel).toBe("the owner");
      expect(JSON.stringify(result)).not.toContain(mail.temporaryPassword);

      const organization = await OrganizationModel.findById(result.organization.id);
      expect(organization!.widgetKey).toEqual(expect.any(String));
    });

    it("lets the invited owner verify, sign in, and run their organisation", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");

      const ownerToken = await acceptInvitation(ctx, "olivia@central.test");
      const read = await as(ctx, ownerToken).get(`/api/v1/organizations/${organization.id}`);

      expect(read.status).toBe(200);
      expect(read.body.data.role).toBe("owner");
      expect(read.body.data.viaPlatformAdmin).toBe(false);
    });

    it("gives two organisations of the same name different slugs and links", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);

      const first = await createOrganization(ctx, adminToken, "Acme", "one@acme.test");
      const second = await createOrganization(ctx, adminToken, "Acme", "two@acme.test");

      expect(first.organization.slug).not.toBe(second.organization.slug);
      expect(first.organization.widgetUrl).not.toBe(second.organization.widgetUrl);
    });

    it("adds an existing staff account as owner without sending a new password", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      await verifiedStaff(ctx, "existing@staff.test");

      const result = await createOrganization(ctx, adminToken, "Second Org", "existing@staff.test");

      expect(result.accountCreated).toBe(false);
      expect(ctx.fake.agentCredentials).toHaveLength(0);
      expect(ctx.fake.invitations.at(-1)).toMatchObject({ to: "existing@staff.test", roleLabel: "the owner" });
    });

    it("refuses an owner address that cannot own an organisation, and creates nothing", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);

      const response = await as(ctx, adminToken)
        .post(ADMIN_ORGANIZATIONS_PATH)
        .send({ name: "Nope", owner: { name: "Grace", email: SUPER_ADMIN_EMAIL } });

      expect(response.status).toBe(422);
      expect(await OrganizationModel.countDocuments({})).toBe(0);
    });

    it("removes the organisation again when the owner's email cannot be delivered", async () => {
      const fake = createFakeEmailProvider();
      const failing: EmailProvider = {
        ...fake.provider,
        async sendAgentCredentials() {
          throw new Error("smtp down");
        },
      };
      const ctx = { fake, app: createApp({ emailProvider: failing }) };
      const adminToken = await superAdminToken(ctx);

      const response = await as(ctx, adminToken)
        .post(ADMIN_ORGANIZATIONS_PATH)
        .send({ name: "Doomed", owner: { name: "Olivia", email: "olivia@doomed.test" } });

      expect(response.status).toBe(500);
      expect(await OrganizationModel.countDocuments({})).toBe(0);
      expect(await UserModel.countDocuments({ email: "olivia@doomed.test" })).toBe(0);
      expect(await MembershipModel.countDocuments({})).toBe(0);
    });

    it("refuses everyone but the super admin", async () => {
      const ctx = buildApp();
      await verifiedStaff(ctx, "owner@example.com");
      const ownerToken = await signIn(ctx, "owner@example.com");

      const response = await as(ctx, ownerToken)
        .post(ADMIN_ORGANIZATIONS_PATH)
        .send({ name: "Mine Now", owner: { name: "Me", email: "me@example.com" } });

      expect(response.status).toBe(403);
      expect(await OrganizationModel.countDocuments({})).toBe(0);
    });

    it("lists every organisation with its chat link", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      await createOrganization(ctx, adminToken, "Other Co", "oscar@other.test");

      const list = await as(ctx, adminToken).get(ADMIN_ORGANIZATIONS_PATH);

      const links = (list.body.data.organizations as { widgetUrl: string }[]).map((entry) => entry.widgetUrl).sort();
      expect(links).toEqual(["http://localhost:5173/widget/centralservice", "http://localhost:5173/widget/other-co"]);
    });
  });

  // ---- suspending ----

  describe("suspending an organisation", () => {
    it("closes its chat link and its workspace, and reactivating opens both again", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      const ownerToken = await acceptInvitation(ctx, "olivia@central.test");
      const statusPath = `${ADMIN_ORGANIZATIONS_PATH}/${organization.id}/status`;

      expect((await as(ctx, adminToken).patch(statusPath).send({ status: "suspended" })).status).toBe(200);

      expect((await request(ctx.app).get(`/api/v1/widget/organizations/${organization.slug}`)).status).toBe(404);
      expect((await as(ctx, ownerToken).get(`/api/v1/organizations/${organization.id}`)).status).toBe(404);

      expect((await as(ctx, adminToken).patch(statusPath).send({ status: "active" })).status).toBe(200);

      expect((await request(ctx.app).get(`/api/v1/widget/organizations/${organization.slug}`)).status).toBe(200);
      expect((await as(ctx, ownerToken).get(`/api/v1/organizations/${organization.id}`)).status).toBe(200);
    });

    it("refuses anything but a known status", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");

      const response = await as(ctx, adminToken)
        .patch(`${ADMIN_ORGANIZATIONS_PATH}/${organization.id}/status`)
        .send({ status: "deleted" });

      expect(response.status).toBe(400);
    });
  });

  // ---- inviting staff ----

  describe("inviting staff into an organisation", () => {
    it("lets the super admin invite into any organisation, in any role", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");

      const response = await as(ctx, adminToken)
        .post(`${ADMIN_ORGANIZATIONS_PATH}/${organization.id}/members`)
        .send({ name: "Alan Turing", email: "alan@central.test", role: "admin" });

      expect(response.status).toBe(201);
      expect(response.body.data.member).toMatchObject({ email: "alan@central.test", role: "admin" });
      expect(ctx.fake.agentCredentials.at(-1)!.roleLabel).toBe("an admin");
    });

    it("refuses a second owner", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");

      const response = await as(ctx, adminToken)
        .post(`${ADMIN_ORGANIZATIONS_PATH}/${organization.id}/members`)
        .send({ name: "Usurper", email: "usurper@central.test", role: "owner" });

      expect(response.status).toBe(422);
      expect(await UserModel.countDocuments({ email: "usurper@central.test" })).toBe(0);
    });

    it("lets an organisation's owner invite a new agent by name and email", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      const ownerToken = await acceptInvitation(ctx, "olivia@central.test");

      const response = await as(ctx, ownerToken)
        .post(`/api/v1/organizations/${organization.id}/members`)
        .send({ name: "Alan Turing", email: "alan@central.test", role: "agent" });

      expect(response.status).toBe(201);
      expect(response.body.data.user).toMatchObject({ name: "Alan Turing", email: "alan@central.test" });

      const agentToken = await acceptInvitation(ctx, "alan@central.test");
      const read = await as(ctx, agentToken).get(`/api/v1/organizations/${organization.id}`);
      expect(read.body.data.role).toBe("agent");
    });

    it("does not let an agent invite anyone", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      await as(ctx, adminToken)
        .post(`${ADMIN_ORGANIZATIONS_PATH}/${organization.id}/members`)
        .send({ name: "Alan Turing", email: "alan@central.test", role: "agent" });
      const agentToken = await acceptInvitation(ctx, "alan@central.test");

      const response = await as(ctx, agentToken)
        .post(`/api/v1/organizations/${organization.id}/members`)
        .send({ name: "Friend", email: "friend@central.test", role: "agent" });

      expect(response.status).toBe(403);
    });

    it("keeps each organisation's admins out of the other organisation", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const central = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      const other = await createOrganization(ctx, adminToken, "Other Co", "oscar@other.test");
      const centralOwner = await acceptInvitation(ctx, "olivia@central.test");
      const conversationId = await customerConversation(ctx, other.organization.id);

      const otherId = other.organization.id;
      expect((await as(ctx, centralOwner).get(`/api/v1/organizations/${otherId}`)).status).toBe(404);
      expect((await as(ctx, centralOwner).get(`/api/v1/organizations/${otherId}/conversations`)).status).toBe(404);
      expect(
        (await as(ctx, centralOwner).get(`/api/v1/organizations/${otherId}/conversations/${conversationId}/messages`))
          .status,
      ).toBe(404);
      expect(
        (
          await as(ctx, centralOwner)
            .post(`/api/v1/organizations/${otherId}/members`)
            .send({ name: "Spy", email: "spy@central.test", role: "agent" })
        ).status,
      ).toBe(404);
      // And a Central conversation list shows nothing of Other's.
      const centralList = await as(ctx, centralOwner).get(`/api/v1/organizations/${central.organization.id}/conversations`);
      expect(centralList.body.data.conversations).toHaveLength(0);
    });
  });

  // ---- the super admin inside an organisation ----

  describe("the super admin inside an organisation", () => {
    it("reads, replies to and assigns an organisation's conversations without a membership", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      const conversationId = await customerConversation(ctx, organization.id);
      const base = `/api/v1/organizations/${organization.id}`;

      const context = await as(ctx, adminToken).get(base);
      expect(context.body.data).toMatchObject({ role: "admin", viaPlatformAdmin: true });

      const list = await as(ctx, adminToken).get(`${base}/conversations`);
      expect(list.body.data.conversations.map((entry: { id: string }) => entry.id)).toEqual([conversationId]);

      const reply = await as(ctx, adminToken)
        .post(`${base}/conversations/${conversationId}/messages`)
        .send({ body: "Let me look into that for you." });
      expect(reply.status).toBe(201);

      const claim = await as(ctx, adminToken)
        .patch(`${base}/conversations/${conversationId}/assignment`)
        .send({ action: "claim" });
      expect(claim.status).toBe(200);

      // Still nobody's member: the access came from the platform grant.
      expect(await MembershipModel.countDocuments({ organizationId: organization.id })).toBe(1);
    });

    it("manages the organisation's team", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");

      const roster = await as(ctx, adminToken).get(`/api/v1/organizations/${organization.id}/members`);

      expect(roster.status).toBe(200);
      expect(roster.body.data.members).toHaveLength(1);
    });

    it("cannot transfer ownership, which only the owner holds", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      const invited = await as(ctx, adminToken)
        .post(`${ADMIN_ORGANIZATIONS_PATH}/${organization.id}/members`)
        .send({ name: "Alan Turing", email: "alan@central.test", role: "admin" });

      const response = await as(ctx, adminToken)
        .post(`/api/v1/organizations/${organization.id}/ownership`)
        .send({ membershipId: invited.body.data.member.membershipId });

      expect(response.status).toBe(403);
    });

    it("is refused in a suspended organisation like everyone else", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      await as(ctx, adminToken).patch(`${ADMIN_ORGANIZATIONS_PATH}/${organization.id}/status`).send({ status: "suspended" });

      expect((await as(ctx, adminToken).get(`/api/v1/organizations/${organization.id}`)).status).toBe(404);
    });

    it("loses that access the moment the grant is revoked", async () => {
      const ctx = buildApp();
      const adminToken = await superAdminToken(ctx);
      const { organization } = await createOrganization(ctx, adminToken, "CentralService", "olivia@central.test");
      await UserModel.updateOne({ email: SUPER_ADMIN_EMAIL }, { $set: { platformRole: "none" } });

      expect((await as(ctx, adminToken).get(`/api/v1/organizations/${organization.id}`)).status).toBe(404);
    });
  });

  // ---- staff cannot create organisations ----

  it("offers staff no way to create an organisation for themselves", async () => {
    const ctx = buildApp();
    await verifiedStaff(ctx, "someone@example.com");
    const token = await signIn(ctx, "someone@example.com");

    const response = await as(ctx, token).post("/api/v1/organizations").send({ name: "My Own Org" });

    expect(response.status).toBe(404);
    expect(await OrganizationModel.countDocuments({})).toBe(0);
  });
});
