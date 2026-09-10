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
import { ROLE_PERMISSIONS, can } from "../src/modules/memberships/permissions";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";

import type { MembershipRole, MembershipStatus } from "../src/modules/memberships/membership.model";

/**
 * Integration coverage for conversation assignment and status (ADR-026): the
 * two `PATCH` routes, the closed-conversation rule they give `status`, every
 * authorization gate in front of them, and the isolation boundaries they must
 * hold.
 *
 * Real MongoDB, real Express, real credentials issued through the real
 * register → verify → login flow — no principal is stubbed, because the point
 * of most of these assertions is exactly which principal the server derives
 * and from where.
 *
 * The two assertions that matter most and are invisible when broken: a claim
 * must set the conversation to the CALLER regardless of what the body says
 * (ADR-026 §2), and a closed conversation must refuse messages from BOTH
 * sides (§6) — an agent-only or customer-only rule would mean "closed" meant
 * two different things depending on who asked.
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

async function signedInStaff(ctx: Ctx, name = "Ada Lovelace") {
  emailCounter += 1;
  const email = `assign${emailCounter}@example.com`;

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

async function createOrganization(ctx: Ctx, accessToken: string, name: string) {
  const response = await request(ctx.app)
    .post(ORGANIZATIONS_PATH)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ name });
  return response.body.data.organization as { id: string };
}

/** Opens a real customer conversation through the real widget surface. */
async function customerConversation(ctx: Ctx, organizationId: string, body = "hello from a customer") {
  const organization = await OrganizationModel.findById(organizationId);
  const session = await request(ctx.app)
    .post(WIDGET_SESSION_PATH)
    .send({ widgetKey: organization!.widgetKey, name: "Grace Hopper", email: "grace@example.com" });

  const widgetToken = session.body.data.token as string;
  const conversation = await request(ctx.app)
    .post(WIDGET_CONVERSATIONS_PATH)
    .set("Authorization", `Bearer ${widgetToken}`)
    .send({});

  const conversationId = conversation.body.data.id as string;

  await request(ctx.app)
    .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
    .set("Authorization", `Bearer ${widgetToken}`)
    .send({ body });

  return { conversationId, widgetToken, customerId: session.body.data.customer.id as string };
}

function addMember(userId: string, organizationId: string, role: MembershipRole, status: MembershipStatus = "active") {
  return MembershipModel.create({ userId, organizationId, role, status });
}

const inboxPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/conversations${suffix}`;

const assignmentPath = (organizationId: string, conversationId: string) =>
  inboxPath(organizationId, `/${conversationId}/assignment`);

const statusPath = (organizationId: string, conversationId: string) =>
  inboxPath(organizationId, `/${conversationId}/status`);

const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

describe("conversation assignment and status", () => {
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

  // ---- claiming ----

  describe("PATCH /conversations/:conversationId/assignment — claim", () => {
    it("assigns the conversation to the calling agent", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      expect(response.status).toBe(200);
      expect(response.body.data.assignedTo.id).toBe(staff.userId);

      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo!.toString()).toBe(staff.userId);
    });

    it("starts unassigned — a conversation nobody has claimed reports null", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await customerConversation(ctx, organization.id);

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(staff.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.conversations[0].assignedTo).toBeNull();
    });

    it("is idempotent — re-claiming your own conversation succeeds", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      const again = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      expect(again.status).toBe(200);
      expect(again.body.data.assignedTo.id).toBe(staff.userId);
    });

    it("refuses a claim on a conversation another agent already holds", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Ada Lovelace");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const colleague = await signedInStaff(ctx, "Grace Hopper");
      await addMember(colleague.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const stolen = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(colleague.accessToken))
        .send({ action: "claim" });

      expect(stolen.status).toBe(409);
      expect(stolen.body.error.code).toBe("CONVERSATION_ALREADY_ASSIGNED");

      // The refusal names no user (ADR-026 §4, §11) — who holds it depends on
      // the reader's own entitlement to the roster.
      expect(JSON.stringify(stolen.body)).not.toContain(owner.userId);
      expect(JSON.stringify(stolen.body)).not.toContain("Ada Lovelace");

      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo!.toString()).toBe(owner.userId);
    });

    it("refuses an owner taking a conversation from an agent — the rule holds for every role", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const agent = await signedInStaff(ctx);
      await addMember(agent.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const override = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      expect(override.status).toBe(409);

      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo!.toString()).toBe(agent.userId);
    });

    it("assigns to the verified caller, never to a userId supplied in the body", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const other = await signedInStaff(ctx);
      await addMember(other.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({
          action: "claim",
          // Every one of these is stripped by the schema before the handler
          // runs (ADR-026 §2, §12) — not rejected, stripped, so a forged
          // value never becomes observable at all.
          assignedTo: other.userId,
          userId: other.userId,
          agentId: other.userId,
          organizationId: UNKNOWN_ID,
          customerId: UNKNOWN_ID,
        });

      expect(response.status).toBe(200);
      expect(response.body.data.assignedTo.id).toBe(staff.userId);

      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo!.toString()).toBe(staff.userId);
      expect(stored!.organizationId.toString()).toBe(organization.id);
    });

    it("rejects an unknown action rather than treating it as a claim", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "assign_to_everyone" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");

      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo).toBeNull();
    });

    it("answers 400 for a malformed conversation id rather than a 500 from a CastError", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, "not-an-object-id"))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---- releasing ----

  describe("PATCH /conversations/:conversationId/assignment — release", () => {
    it("unassigns a conversation the caller holds", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "release" });

      expect(response.status).toBe(200);
      expect(response.body.data.assignedTo).toBeNull();

      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo).toBeNull();
    });

    it("is idempotent — releasing an unassigned conversation succeeds", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "release" });

      expect(response.status).toBe(200);
      expect(response.body.data.assignedTo).toBeNull();
    });

    it("refuses releasing a conversation another agent holds", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const colleague = await signedInStaff(ctx);
      await addMember(colleague.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(colleague.accessToken))
        .send({ action: "release" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONVERSATION_ALREADY_ASSIGNED");

      const stored = await ConversationModel.findById(conversationId);
      expect(stored!.assignedTo!.toString()).toBe(owner.userId);
    });

    it("lets a released conversation be claimed by someone else", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const colleague = await signedInStaff(ctx);
      await addMember(colleague.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);
      const path = assignmentPath(organization.id, conversationId);

      await request(ctx.app).patch(path).set(authed(owner.accessToken)).send({ action: "claim" });
      await request(ctx.app).patch(path).set(authed(owner.accessToken)).send({ action: "release" });

      const response = await request(ctx.app)
        .patch(path)
        .set(authed(colleague.accessToken))
        .send({ action: "claim" });

      expect(response.status).toBe(200);
      expect(response.body.data.assignedTo.id).toBe(colleague.userId);
    });
  });

  // ---- assignee disclosure ----

  describe("assignee disclosure", () => {
    it("shows the assignee's name to a reader whose role holds member.read", async () => {
      const ctx = buildApp();
      // An owner holds `member.read` (ADR-026 §11).
      const owner = await signedInStaff(ctx, "Ada Lovelace");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(owner.accessToken));

      expect(can("owner", "member.read")).toBe(true);
      expect(response.body.data.conversations[0].assignedTo).toEqual({ id: owner.userId, name: "Ada Lovelace" });
    });

    it("withholds the assignee's name from an agent, who does not hold member.read", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Ada Lovelace");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const agent = await signedInStaff(ctx, "Katherine Johnson");
      await addMember(agent.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(agent.accessToken));

      /*
        The `agent` role lacks `member.read`, so rendering a colleague's name
        into its inbox would hand it, through a conversation projection,
        exactly what the permission table withholds (ADR-026 §11).

        The ID is still disclosed — it is what lets an agent tell their own
        work from someone else's — and it is strictly less than the roster.
      */
      expect(can("agent", "member.read")).toBe(false);
      expect(response.body.data.conversations[0].assignedTo).toEqual({ id: owner.userId, name: null });
      expect(JSON.stringify(response.body)).not.toContain("Ada Lovelace");
    });

    it("never discloses the assignee's email, to any reader", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(owner.accessToken));

      expect(JSON.stringify(response.body)).not.toContain(owner.email);
    });

    it("reports an assignee whose membership was revoked as a nameless assignment", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, "Ada Lovelace");
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      // NOT "Grace Hopper" — the customer fixture uses that name, and a
      // collision would make this assertion pass on the customer's row.
      const agent = await signedInStaff(ctx, "Katherine Johnson");
      await addMember(agent.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      // The colleague leaves the team. Nothing sweeps `assignedTo`
      // (ADR-026 §15), and the name must not survive the boundary closing.
      await MembershipModel.updateOne({ userId: agent.userId, organizationId: organization.id }, { status: "suspended" });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(owner.accessToken));

      expect(response.body.data.conversations[0].assignedTo).toEqual({ id: agent.userId, name: null });
      expect(JSON.stringify(response.body)).not.toContain("Katherine Johnson");
    });
  });

  // ---- filtering ----

  describe("list filters", () => {
    it("filters to the caller's own assignments with assignee=me", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const colleague = await signedInStaff(ctx);
      await addMember(colleague.userId, organization.id, "agent");

      const mine = await customerConversation(ctx, organization.id);
      const theirs = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, mine.conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });
      await request(ctx.app)
        .patch(assignmentPath(organization.id, theirs.conversationId))
        .set(authed(colleague.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?assignee=me`)
        .set(authed(owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([mine.conversationId]);
    });

    it("resolves assignee=me from the token, so two agents see different lists for one query", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const colleague = await signedInStaff(ctx);
      await addMember(colleague.userId, organization.id, "agent");

      const mine = await customerConversation(ctx, organization.id);
      const theirs = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, mine.conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });
      await request(ctx.app)
        .patch(assignmentPath(organization.id, theirs.conversationId))
        .set(authed(colleague.accessToken))
        .send({ action: "claim" });

      const path = `${inboxPath(organization.id)}?assignee=me`;
      const asOwner = await request(ctx.app).get(path).set(authed(owner.accessToken));
      const asColleague = await request(ctx.app).get(path).set(authed(colleague.accessToken));

      expect(asOwner.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([mine.conversationId]);
      expect(asColleague.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([theirs.conversationId]);
    });

    it("filters to the unclaimed queue with assignee=unassigned", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const claimed = await customerConversation(ctx, organization.id);
      const free = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, claimed.conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      const response = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?assignee=unassigned`)
        .set(authed(staff.accessToken));

      expect(response.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([free.conversationId]);
    });

    it("filters by status", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const open = await customerConversation(ctx, organization.id);
      const closed = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, closed.conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const closedOnly = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?status=closed`)
        .set(authed(staff.accessToken));
      const openOnly = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?status=open`)
        .set(authed(staff.accessToken));

      expect(closedOnly.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([closed.conversationId]);
      expect(openOnly.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([open.conversationId]);
    });

    it("returns everything when no filter is given — the default is unchanged", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const first = await customerConversation(ctx, organization.id);
      const second = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, first.conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(staff.accessToken));

      expect(response.body.data.conversations).toHaveLength(2);
      expect(response.body.data.conversations.map((c: { id: string }) => c.id).sort()).toEqual(
        [first.conversationId, second.conversationId].sort(),
      );
    });

    it("rejects an assignee filter naming a user id rather than a relation", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await customerConversation(ctx, organization.id);

      /*
        The filter names a RELATION, never a person (ADR-026 §5). A user-id
        form would be a client asking about someone else's queue, which is the
        roster-disclosure question §11 exists to avoid.
      */
      const response = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?assignee=${UNKNOWN_ID}`)
        .set(authed(staff.accessToken));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an unknown status filter", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?status=archived`)
        .set(authed(staff.accessToken));

      expect(response.status).toBe(400);
    });

    it("applies the filter in the query, so a filtered page still pages correctly", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const conversations = [
        await customerConversation(ctx, organization.id),
        await customerConversation(ctx, organization.id),
        await customerConversation(ctx, organization.id),
      ];

      // All three claimed, so the filter matches every row and the cursor has
      // to page through a filtered set rather than a trimmed one
      // (ADR-026 §5).
      for (const conversation of conversations) {
        await request(ctx.app)
          .patch(assignmentPath(organization.id, conversation.conversationId))
          .set(authed(staff.accessToken))
          .send({ action: "claim" });
      }

      const first = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?assignee=me&limit=2`)
        .set(authed(staff.accessToken));

      expect(first.body.data.conversations).toHaveLength(2);
      expect(first.body.data.nextCursor).not.toBeNull();

      const second = await request(ctx.app)
        .get(`${inboxPath(organization.id)}?assignee=me&limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)
        .set(authed(staff.accessToken));

      const seen = [
        ...first.body.data.conversations.map((c: { id: string }) => c.id),
        ...second.body.data.conversations.map((c: { id: string }) => c.id),
      ];

      expect(new Set(seen).size).toBe(3);
    });
  });

  // ---- status ----

  describe("PATCH /conversations/:conversationId/status", () => {
    it("closes a conversation", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("closed");
      expect((await ConversationModel.findById(conversationId))!.status).toBe("closed");
    });

    it("reopens a closed conversation", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const response = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "open" });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("open");
      expect((await ConversationModel.findById(conversationId))!.status).toBe("open");
    });

    it("is idempotent in both directions", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);
      const path = statusPath(organization.id, conversationId);

      const openAgain = await request(ctx.app).patch(path).set(authed(staff.accessToken)).send({ status: "open" });
      expect(openAgain.status).toBe(200);

      await request(ctx.app).patch(path).set(authed(staff.accessToken)).send({ status: "closed" });
      const closeAgain = await request(ctx.app).patch(path).set(authed(staff.accessToken)).send({ status: "closed" });

      expect(closeAgain.status).toBe(200);
      expect(closeAgain.body.data.status).toBe("closed");
    });

    it("preserves the assignment across a close and a reopen", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const reopened = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "open" });

      expect(reopened.body.data.assignedTo.id).toBe(staff.userId);
    });

    it("refuses reopening when the customer already has a newer open conversation", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      // The visitor writes in again and gets a NEW open conversation — ADR-022
      // §7's resolve-or-create, unchanged by this slice.
      const resumed = await request(ctx.app)
        .post(WIDGET_CONVERSATIONS_PATH)
        .set(authed(widgetToken))
        .send({});
      expect(resumed.body.data.id).not.toBe(conversationId);

      const response = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "open" });

      /*
        ADR-022 §3's partial unique index refusing the write, translated
        rather than absorbed (ADR-026 §7): closing the newer conversation to
        make room would destroy a thread the customer is actively using.
      */
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONVERSATION_REOPEN_CONFLICT");
      expect((await ConversationModel.findById(conversationId))!.status).toBe("closed");
    });

    it("leaves the newer conversation untouched when a reopen is refused", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const resumed = await request(ctx.app).post(WIDGET_CONVERSATIONS_PATH).set(authed(widgetToken)).send({});
      const newId = resumed.body.data.id as string;

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "open" });

      expect((await ConversationModel.findById(newId))!.status).toBe("open");
    });

    it("rejects a status outside the enum", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "deleted" });

      expect(response.status).toBe(400);
      expect((await ConversationModel.findById(conversationId))!.status).toBe("open");
    });

    it("answers 404 for an unknown conversation id", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app)
        .patch(statusPath(organization.id, UNKNOWN_ID))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  // ---- the closed-conversation rule ----

  describe("closed conversations refuse new messages", () => {
    it("refuses a customer message over REST", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const before = await MessageModel.countDocuments({ conversationId });

      const response = await request(ctx.app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set(authed(widgetToken))
        .send({ body: "are you still there?" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONVERSATION_CLOSED");
      expect(await MessageModel.countDocuments({ conversationId })).toBe(before);
    });

    it("refuses an agent reply", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const response = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "one more thing" });

      /*
        Symmetric across both senders, deliberately (ADR-026 §6): an
        agent-only or customer-only rule would mean "closed" meant two
        different things depending on who asked.
      */
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONVERSATION_CLOSED");
      expect(await MessageModel.countDocuments({ conversationId, senderType: "agent" })).toBe(0);
    });

    it("still allows reading a closed conversation and its history", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id, "the original question");

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const detail = await request(ctx.app)
        .get(inboxPath(organization.id, `/${conversationId}`))
        .set(authed(staff.accessToken));
      const history = await request(ctx.app)
        .get(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken));

      // Closing ends the exchange, not the record (ADR-026 §6).
      expect(detail.status).toBe(200);
      expect(detail.body.data.status).toBe("closed");
      expect(history.status).toBe(200);
      expect(history.body.data.messages[0].body).toBe("the original question");
    });

    it("still allows claiming and releasing a closed conversation", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const claimed = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });

      expect(claimed.status).toBe(200);
      expect(claimed.body.data.status).toBe("closed");
      expect(claimed.body.data.assignedTo.id).toBe(staff.userId);
    });

    it("accepts messages again once reopened", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);
      const path = statusPath(organization.id, conversationId);

      await request(ctx.app).patch(path).set(authed(staff.accessToken)).send({ status: "closed" });
      await request(ctx.app).patch(path).set(authed(staff.accessToken)).send({ status: "open" });

      const fromCustomer = await request(ctx.app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set(authed(widgetToken))
        .send({ body: "thanks for reopening" });

      const fromAgent = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "happy to help" });

      expect(fromCustomer.status).toBe(201);
      expect(fromAgent.status).toBe(201);
    });

    it("lets the customer open a fresh conversation after theirs is closed", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      // The widget's recovery path (ADR-026 §8): resolve-or-create returns a
      // NEW open conversation precisely because the old one is closed.
      const resolved = await request(ctx.app).post(WIDGET_CONVERSATIONS_PATH).set(authed(widgetToken)).send({});
      const newId = resolved.body.data.id as string;

      const sent = await request(ctx.app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${newId}/messages`)
        .set(authed(widgetToken))
        .send({ body: "a new question" });

      expect(newId).not.toBe(conversationId);
      expect(sent.status).toBe(201);
    });

    it("does not tell the customer who closed it, or that an agent did", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx, "Ada Lovelace");
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });
      await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      const refused = await request(ctx.app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set(authed(widgetToken))
        .send({ body: "hello?" });

      // Staff identity never crosses to the customer (ADR-026 §10).
      const body = JSON.stringify(refused.body);
      expect(body).not.toContain(staff.userId);
      expect(body).not.toContain("Ada Lovelace");
      expect(body).not.toContain(staff.email);
    });
  });

  // ---- authorization ----

  describe("authorization", () => {
    it.each([["owner"], ["admin"], ["supervisor"], ["agent"]] as [MembershipRole][])(
      "lets a %s claim, release, close, and reopen",
      async (role) => {
        const ctx = buildApp();
        const owner = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, owner.accessToken, "Acme");

        const member = await signedInStaff(ctx);
        if (role !== "owner") await addMember(member.userId, organization.id, role);

        const actor = role === "owner" ? owner : member;
        const { conversationId } = await customerConversation(ctx, organization.id);

        const claimed = await request(ctx.app)
          .patch(assignmentPath(organization.id, conversationId))
          .set(authed(actor.accessToken))
          .send({ action: "claim" });
        const closed = await request(ctx.app)
          .patch(statusPath(organization.id, conversationId))
          .set(authed(actor.accessToken))
          .send({ status: "closed" });
        const reopened = await request(ctx.app)
          .patch(statusPath(organization.id, conversationId))
          .set(authed(actor.accessToken))
          .send({ status: "open" });
        const released = await request(ctx.app)
          .patch(assignmentPath(organization.id, conversationId))
          .set(authed(actor.accessToken))
          .send({ action: "release" });

        expect([claimed.status, closed.status, reopened.status, released.status]).toEqual([200, 200, 200, 200]);
      },
    );

    it("gates assignment on conversation.assign, which every role holds", () => {
      /*
        ADR-026 §3. Every role that can reply can also claim — a role that
        could answer conversations but never pick one up could only ever work
        someone else's queue.

        The 403 path itself is exercised by `requirePermission.test.ts`
        against a role that lacks the permission it is given; no role in the
        current table lacks this one, which is the honest reason it is not
        re-proved here.
      */
      for (const role of ["owner", "admin", "supervisor", "agent"] as MembershipRole[]) {
        expect(can(role, "conversation.assign")).toBe(true);
      }
    });

    it("keeps conversation.assign distinct from conversation.reply in the catalogue", () => {
      // Ownership and participation are orthogonal (ADR-026 §3): a tenant that
      // later wants "supervisors assign, agents close" gets it from a table
      // edit, and would get nothing if the two rode on one permission.
      expect(ROLE_PERMISSIONS.agent).toContain("conversation.assign");
      expect(ROLE_PERMISSIONS.agent).toContain("conversation.reply");
      expect(ROLE_PERMISSIONS.agent).not.toContain("member.read");
    });

    it.each([
      ["assignment", (o: string, c: string) => assignmentPath(o, c), { action: "claim" }],
      ["status", (o: string, c: string) => statusPath(o, c), { status: "closed" }],
    ])("refuses an unauthenticated %s change", async (_name, path, body) => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app).patch(path(organization.id, conversationId)).send(body);

      expect(response.status).toBe(401);
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(conversationId))!.status).toBe("open");
    });

    it("refuses a widget token — a customer credential cannot change assignment", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(widgetToken))
        .send({ action: "claim" });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
    });

    it("refuses a customer closing their own conversation", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(widgetToken))
        .send({ status: "closed" });

      expect(response.status).toBe(401);
      expect((await ConversationModel.findById(conversationId))!.status).toBe("open");
    });

    it("refuses an expired access token", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const { SignJWT } = await import("jose");
      const expired = await new SignJWT({ sid: UNKNOWN_ID })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(staff.userId)
        .setIssuer("serviqo")
        .setAudience("serviqo-dashboard")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 60 * 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60 * 60)
        .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!));

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(expired))
        .send({ action: "claim" });

      expect(response.status).toBe(401);
    });

    it("refuses a member whose membership is not active", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const suspended = await signedInStaff(ctx);
      await addMember(suspended.userId, organization.id, "agent", "suspended");

      const { conversationId } = await customerConversation(ctx, organization.id);

      const claim = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(suspended.accessToken))
        .send({ action: "claim" });
      const close = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(suspended.accessToken))
        .send({ status: "closed" });

      // Indistinguishable from "no such organization" (ADR-017 §6).
      expect(claim.status).toBe(404);
      expect(close.status).toBe(404);
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(conversationId))!.status).toBe("open");
    });

    it("refuses a member whose membership is still invited", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      const invited = await signedInStaff(ctx);
      await addMember(invited.userId, organization.id, "agent", "invited");

      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(invited.accessToken))
        .send({ action: "claim" });

      expect(response.status).toBe(404);
    });

    it("refuses both routes when the organization is suspended", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await OrganizationModel.updateOne({ _id: organization.id }, { status: "suspended" });

      const claim = await request(ctx.app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ action: "claim" });
      const close = await request(ctx.app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(staff.accessToken))
        .send({ status: "closed" });

      expect(claim.status).toBe(404);
      expect(close.status).toBe(404);
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(conversationId))!.status).toBe("open");
    });
  });

  // ---- cross-organization isolation ----

  describe("organization isolation", () => {
    it("refuses claiming a conversation in another tenant", async () => {
      const ctx = buildApp();
      const insider = await signedInStaff(ctx);
      const acme = await createOrganization(ctx, insider.accessToken, "Acme");

      const outsider = await signedInStaff(ctx);
      const globex = await createOrganization(ctx, outsider.accessToken, "Globex");

      const { conversationId } = await customerConversation(ctx, acme.id);

      // Named through the outsider's OWN tenant, which is the only path they
      // can reach: `requireOrganization` proves membership in the path
      // segment before any handler runs.
      const response = await request(ctx.app)
        .patch(assignmentPath(globex.id, conversationId))
        .set(authed(outsider.accessToken))
        .send({ action: "claim" });

      expect(response.status).toBe(404);
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
    });

    it("refuses closing a conversation in another tenant", async () => {
      const ctx = buildApp();
      const insider = await signedInStaff(ctx);
      const acme = await createOrganization(ctx, insider.accessToken, "Acme");
      const outsider = await signedInStaff(ctx);
      const globex = await createOrganization(ctx, outsider.accessToken, "Globex");

      const { conversationId } = await customerConversation(ctx, acme.id);

      const response = await request(ctx.app)
        .patch(statusPath(globex.id, conversationId))
        .set(authed(outsider.accessToken))
        .send({ status: "closed" });

      expect(response.status).toBe(404);
      expect((await ConversationModel.findById(conversationId))!.status).toBe("open");
    });

    it("makes a cross-tenant conversation id indistinguishable from an unknown one", async () => {
      const ctx = buildApp();
      const insider = await signedInStaff(ctx);
      const acme = await createOrganization(ctx, insider.accessToken, "Acme");
      const outsider = await signedInStaff(ctx);
      const globex = await createOrganization(ctx, outsider.accessToken, "Globex");

      const { conversationId } = await customerConversation(ctx, acme.id);

      const real = await request(ctx.app)
        .patch(assignmentPath(globex.id, conversationId))
        .set(authed(outsider.accessToken))
        .send({ action: "claim" });
      const fake = await request(ctx.app)
        .patch(assignmentPath(globex.id, UNKNOWN_ID))
        .set(authed(outsider.accessToken))
        .send({ action: "claim" });

      // Identical apart from the request-scoped envelope metadata
      // (ADR-025 §10, ADR-026 §12): the 404 is produced by the query missing,
      // not by a branch comparing tenants.
      expect(real.status).toBe(fake.status);
      expect(real.status).toBe(404);
      expect(real.body.error.code).toBe(fake.body.error.code);
      expect(real.body.error.message).toBe(fake.body.error.message);
    });

    it("refuses a staff member naming an organization they do not belong to", async () => {
      const ctx = buildApp();
      const insider = await signedInStaff(ctx);
      const acme = await createOrganization(ctx, insider.accessToken, "Acme");
      const outsider = await signedInStaff(ctx);

      const { conversationId } = await customerConversation(ctx, acme.id);

      const response = await request(ctx.app)
        .patch(assignmentPath(acme.id, conversationId))
        .set(authed(outsider.accessToken))
        .send({ action: "claim" });

      expect(response.status).toBe(404);
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
    });

    it("does not list another tenant's conversations under any filter", async () => {
      const ctx = buildApp();
      const insider = await signedInStaff(ctx);
      const acme = await createOrganization(ctx, insider.accessToken, "Acme");
      const outsider = await signedInStaff(ctx);
      const globex = await createOrganization(ctx, outsider.accessToken, "Globex");

      await customerConversation(ctx, acme.id);

      for (const query of ["", "?assignee=unassigned", "?assignee=me", "?status=open", "?status=closed"]) {
        const response = await request(ctx.app)
          .get(`${inboxPath(globex.id)}${query}`)
          .set(authed(outsider.accessToken));

        expect(response.status).toBe(200);
        expect(response.body.data.conversations).toEqual([]);
      }
    });

    it("does not resolve an assignee from another tenant", async () => {
      const ctx = buildApp();
      const insider = await signedInStaff(ctx, "Ada Lovelace");
      // Created so the insider has a real membership SOMEWHERE — just not in
      // the tenant whose inbox is read below, which is the whole point.
      await createOrganization(ctx, insider.accessToken, "Acme");
      const outsider = await signedInStaff(ctx, "Hedy Lamarr");
      const globex = await createOrganization(ctx, outsider.accessToken, "Globex");

      const { conversationId } = await customerConversation(ctx, globex.id);

      /*
        Written directly, because no route can produce it: `assignedTo` has
        one source and it is the verified caller (ADR-026 §2). The point is
        that even a corrupted document cannot make the projection reach across
        the tenant boundary — the membership query comes first (ADR-026 §11).
      */
      await ConversationModel.updateOne({ _id: conversationId }, { assignedTo: insider.userId });

      const response = await request(ctx.app).get(inboxPath(globex.id)).set(authed(outsider.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.conversations[0].assignedTo).toEqual({ id: insider.userId, name: null });
      expect(JSON.stringify(response.body)).not.toContain("Ada Lovelace");
      expect(JSON.stringify(response.body)).not.toContain(insider.email);
    });
  });

  // ---- rate limiting ----

  describe("rate limiting", () => {
    it("bounds assignment changes with the authenticated write class", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);
      const path = assignmentPath(organization.id, conversationId);

      /*
        Creating the organization already spent one write from this user's
        budget, so the loop below runs to the remaining edge rather than to
        the raw limit. Claiming is idempotent (ADR-026 §4), which is what lets
        the same request repeat without changing the outcome under test.
      */
      let refused = false;
      for (let attempt = 0; attempt < AUTHENTICATED_WRITE_LIMIT + 1; attempt += 1) {
        const response = await request(ctx.app).patch(path).set(authed(staff.accessToken)).send({ action: "claim" });
        if (response.status === 429) {
          expect(response.body.error.code).toBe("TOO_MANY_REQUESTS");
          // Names no limit, no window, and no class (ADR-018 §6).
          expect(JSON.stringify(response.body)).not.toContain("authenticatedWrite");
          refused = true;
          break;
        }
      }

      expect(refused).toBe(true);
    });

    it("bounds status changes with the same class", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);
      const path = statusPath(organization.id, conversationId);

      let refused = false;
      for (let attempt = 0; attempt < AUTHENTICATED_WRITE_LIMIT + 1; attempt += 1) {
        const response = await request(ctx.app).patch(path).set(authed(staff.accessToken)).send({ status: "closed" });
        if (response.status === 429) {
          refused = true;
          break;
        }
      }

      expect(refused).toBe(true);
    });

    it("keys the bound by user, so one agent cannot exhaust another's budget", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const busy = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, busy.accessToken, "Acme");
      const quiet = await signedInStaff(ctx);
      await addMember(quiet.userId, organization.id, "agent");

      const { conversationId } = await customerConversation(ctx, organization.id);
      const path = statusPath(organization.id, conversationId);

      for (let attempt = 0; attempt < AUTHENTICATED_WRITE_LIMIT + 1; attempt += 1) {
        const response = await request(ctx.app).patch(path).set(authed(busy.accessToken)).send({ status: "closed" });
        if (response.status === 429) break;
      }

      const stillFresh = await request(ctx.app)
        .patch(path)
        .set(authed(quiet.accessToken))
        .send({ status: "closed" });

      expect(stillFresh.status).not.toBe(429);
    });
  });

  // ---- logging hygiene ----

  describe("logging hygiene", () => {
    it("keeps credentials, names, and customer email out of the logs", async () => {
      const written: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        written.push(chunk.toString());
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;

      let staffEmail: string | undefined;

      try {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx, "Ada Lovelace");
        staffEmail = staff.email;
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");
        const { conversationId } = await customerConversation(ctx, organization.id);

        await request(ctx.app)
          .patch(assignmentPath(organization.id, conversationId))
          .set(authed(staff.accessToken))
          .send({ action: "claim" });
        await request(ctx.app)
          .patch(statusPath(organization.id, conversationId))
          .set(authed(staff.accessToken))
          .send({ status: "closed" });
        await request(ctx.app)
          .patch(assignmentPath(organization.id, conversationId))
          .set(authed(staff.accessToken))
          .send({ action: "release" });
      } finally {
        process.stdout.write = original;
      }

      const output = written.join("");

      expect(output).not.toContain(PASSWORD);
      expect(output).not.toContain("Bearer ");
      expect(output).not.toContain("grace@example.com");
      expect(staffEmail).toBeDefined();
      expect(output).not.toContain(staffEmail!);
      /*
        The assignee's NAME is never logged (ADR-026 §11, §12): a log line is
        read by operators who did not go through `can(role, "member.read")`.
        The user ID is deliberately present — an operator needs to know who
        took a conversation.
      */
      expect(output).not.toContain("Ada Lovelace");
    });

  });
});
