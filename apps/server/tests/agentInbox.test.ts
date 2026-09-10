import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AUTHENTICATED_WRITE_LIMIT, MESSAGE_BODY_MAX_LENGTH } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";

import type { MembershipRole, MembershipStatus } from "../src/modules/memberships/membership.model";

/**
 * Integration coverage for the agent inbox (ADR-025): the four staff routes,
 * every authorization gate in front of them, and the isolation boundaries
 * they must hold.
 *
 * Real MongoDB, real Express, real credentials issued through the real
 * register → verify → login flow — no principal is stubbed, because the
 * point of most of these assertions is exactly which principal the server
 * derives and from where.
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

async function signedInStaff(ctx: Ctx) {
  emailCounter += 1;
  const email = `staff${emailCounter}@example.com`;

  await request(ctx.app).post(REGISTER_PATH).send({ name: "Ada Lovelace", email, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code });

  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return {
    accessToken: login.body.data.accessToken as string,
    userId: login.body.data.user.id as string,
    email,
  };
}

/** Creates an organization through the real endpoint, so the owner membership is real. */
async function createOrganization(ctx: Ctx, accessToken: string, name: string) {
  const response = await request(ctx.app)
    .post(ORGANIZATIONS_PATH)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ name });
  return response.body.data.organization as { id: string; name: string; slug: string };
}

/**
 * Opens a real customer conversation through the real widget surface, so
 * every row the inbox reads was produced the way production produces one.
 */
async function customerConversation(ctx: Ctx, organizationId: string, body = "hello from a customer") {
  const organization = await OrganizationModel.findById(organizationId);
  const session = await request(ctx.app)
    .post(WIDGET_SESSION_PATH)
    .send({ widgetKey: organization!.widgetKey, name: "Grace Hopper", email: "grace@example.com" });

  const widgetTokenValue = session.body.data.token as string;
  const conversation = await request(ctx.app)
    .post(WIDGET_CONVERSATIONS_PATH)
    .set("Authorization", `Bearer ${widgetTokenValue}`)
    .send({});

  const conversationId = conversation.body.data.id as string;

  await request(ctx.app)
    .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
    .set("Authorization", `Bearer ${widgetTokenValue}`)
    .send({ body });

  return { conversationId, widgetToken: widgetTokenValue, customerId: session.body.data.customer.id as string };
}

/** Puts an existing user into an existing organization with a chosen standing. */
function addMember(userId: string, organizationId: string, role: MembershipRole, status: MembershipStatus = "active") {
  return MembershipModel.create({ userId, organizationId, role, status });
}

const inboxPath = (organizationId: string, suffix = "") =>
  `${ORGANIZATIONS_PATH}/${organizationId}/conversations${suffix}`;

const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

describe("agent inbox", () => {
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

  // ---- listing conversations ----

  describe("GET /organizations/:organizationId/conversations", () => {
    it("lists the tenant's conversations with the customer each is with", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(staff.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.conversations).toHaveLength(1);

      const [row] = response.body.data.conversations;
      expect(row.id).toBe(conversationId);
      expect(row.status).toBe("open");
      // The staff projection carries the customer; the widget's deliberately
      // does not (ADR-025 §7).
      expect(row.customer).toMatchObject({ name: "Grace Hopper", email: "grace@example.com" });
    });

    it("returns an empty list rather than an error for a tenant with no conversations", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Quiet Co");

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(staff.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ conversations: [], nextCursor: null });
    });

    it("orders most recently active first", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const first = await customerConversation(ctx, organization.id);
      const second = await customerConversation(ctx, organization.id);

      /*
        `lastMessageAt` is what the list sorts on (ADR-025 §5). Set explicitly
        rather than relying on the milliseconds between two awaited requests,
        which is precisely the tie the `_id` tiebreak exists for and not what
        this test is about.
      */
      await ConversationModel.updateOne({ _id: first.conversationId }, { lastMessageAt: new Date("2026-01-01") });
      await ConversationModel.updateOne({ _id: second.conversationId }, { lastMessageAt: new Date("2026-06-01") });

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(staff.accessToken));

      expect(response.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([
        second.conversationId,
        first.conversationId,
      ]);
    });

    it("pages with a cursor and does not repeat or skip a row on a lastMessageAt tie", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const created = [];
      for (let i = 0; i < 3; i += 1) created.push(await customerConversation(ctx, organization.id));

      /*
        The case the composite cursor exists for: three conversations sharing
        one `lastMessageAt` to the millisecond. A cursor that carried only the
        timestamp would skip or repeat here (ADR-025 §5).
      */
      const tied = new Date("2026-03-03T03:03:03.003Z");
      await ConversationModel.updateMany({ organizationId: organization.id }, { lastMessageAt: tied });

      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 3; page += 1) {
        const url: string = inboxPath(organization.id, `?limit=1${cursor === null ? "" : `&cursor=${cursor}`}`);
        const response = await request(ctx.app).get(url).set(authed(staff.accessToken));

        expect(response.status).toBe(200);
        for (const row of response.body.data.conversations) seen.push(row.id);
        cursor = response.body.data.nextCursor;
      }

      expect(new Set(seen).size).toBe(3);
      expect(seen.sort()).toEqual(created.map((c) => c.conversationId).sort());
      expect(cursor).toBeNull();
    });

    it("rejects a malformed cursor as a validation error rather than returning nothing", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app)
        .get(inboxPath(organization.id, "?cursor=not-a-cursor"))
        .set(authed(staff.accessToken));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a limit above the page maximum", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app)
        .get(inboxPath(organization.id, "?limit=1000"))
        .set(authed(staff.accessToken));

      expect(response.status).toBe(400);
    });
  });

  // ---- conversation detail and history ----

  describe("conversation detail and history", () => {
    it("reads one conversation and its messages in order", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id, "first");

      const detail = await request(ctx.app)
        .get(inboxPath(organization.id, `/${conversationId}`))
        .set(authed(staff.accessToken));

      expect(detail.status).toBe(200);
      expect(detail.body.data.id).toBe(conversationId);

      const history = await request(ctx.app)
        .get(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken));

      expect(history.status).toBe(200);
      expect(history.body.data.messages).toHaveLength(1);
      expect(history.body.data.messages[0]).toMatchObject({ body: "first", senderType: "customer" });
    });

    it("answers 404 for an unknown conversation id", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app)
        .get(inboxPath(organization.id, `/${UNKNOWN_ID}`))
        .set(authed(staff.accessToken));

      expect(response.status).toBe(404);
    });

    it("answers 400 for a malformed conversation id rather than a 500 from a CastError", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app)
        .get(inboxPath(organization.id, "/not-an-object-id"))
        .set(authed(staff.accessToken));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---- sending as an agent ----

  describe("POST /organizations/:organizationId/conversations/:conversationId/messages", () => {
    it("persists an agent message with senderType agent", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "an agent reply" });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ body: "an agent reply", senderType: "agent", conversationId });

      const stored = await MessageModel.findById(response.body.data.id);
      expect(stored!.senderType).toBe("agent");
    });

    it("copies customerId from the conversation, never from the request", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, customerId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        // A forged customerId, pointing at a real customer in ANOTHER tenant.
        .send({ body: "reply", customerId: UNKNOWN_ID });

      expect(response.status).toBe(201);

      const stored = await MessageModel.findById(response.body.data.id);
      // The conversation's own customer (ADR-025 §6), not the submitted one.
      expect(stored!.customerId.toString()).toBe(customerId);
    });

    it("ignores a forged senderType in the body", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "reply", senderType: "customer" });

      expect(response.status).toBe(201);
      // Stripped by Zod before the controller ran (ADR-022 §5, ADR-025 §6):
      // the literal in the service is the only thing that decides this.
      expect(response.body.data.senderType).toBe("agent");
    });

    it("ignores a forged organizationId in the body", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const other = await createOrganization(ctx, staff.accessToken, "Other Co");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "reply", organizationId: other.id });

      expect(response.status).toBe(201);

      const stored = await MessageModel.findById(response.body.data.id);
      // The tenant came from the PATH, which requireOrganization proved
      // (ADR-017 §1) — the body's value was never consulted.
      expect(stored!.organizationId.toString()).toBe(organization.id);
    });

    it("rejects an empty body and an over-long body", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const empty = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "   " });

      const tooLong = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "x".repeat(MESSAGE_BODY_MAX_LENGTH + 1) });

      expect(empty.status).toBe(400);
      expect(tooLong.status).toBe(400);
    });

    it("appears in the customer's own history, attributed to the agent", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(ctx, organization.id);

      await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "how can I help?" });

      const customerView = await request(ctx.app)
        .get(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set({ Authorization: `Bearer ${widgetToken}` });

      expect(customerView.status).toBe(200);
      expect(customerView.body.data.messages.map((m: { senderType: string }) => m.senderType)).toEqual([
        "customer",
        "agent",
      ]);
    });

    it("moves the conversation to the top of the inbox", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const older = await customerConversation(ctx, organization.id);
      const newer = await customerConversation(ctx, organization.id);
      await ConversationModel.updateOne({ _id: older.conversationId }, { lastMessageAt: new Date("2026-01-01") });
      await ConversationModel.updateOne({ _id: newer.conversationId }, { lastMessageAt: new Date("2026-06-01") });

      await request(ctx.app)
        .post(inboxPath(organization.id, `/${older.conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "bumping this one" });

      const list = await request(ctx.app).get(inboxPath(organization.id)).set(authed(staff.accessToken));

      expect(list.body.data.conversations[0].id).toBe(older.conversationId);
    });
  });

  // ---- authentication ----

  describe("authentication", () => {
    it.each([
      ["list", (organizationId: string) => inboxPath(organizationId)],
      ["detail", (organizationId: string) => inboxPath(organizationId, `/${UNKNOWN_ID}`)],
      ["history", (organizationId: string) => inboxPath(organizationId, `/${UNKNOWN_ID}/messages`)],
    ])("refuses an unauthenticated %s request", async (_name, path) => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app).get(path(organization.id));

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("refuses an unauthenticated send", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .send({ body: "no credential" });

      expect(response.status).toBe(401);
      expect(await MessageModel.countDocuments({ senderType: "agent" })).toBe(0);
    });

    it("refuses a garbage bearer token", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed("not.a.jwt"));

      expect(response.status).toBe(401);
    });

    it("refuses a widget token — a customer credential cannot reach a staff route", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { widgetToken } = await customerConversation(ctx, organization.id);

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(widgetToken));

      /*
        Fails at the SIGNATURE, not at a claim: the two formats are signed
        with different keys (ADR-019 §8). The audience separation is the
        weaker of the two guarantees and this proves the stronger one holds.
      */
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("refuses an expired access token", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const { SignJWT } = await import("jose");
      const expired = await new SignJWT({ sid: UNKNOWN_ID })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(staff.userId)
        .setIssuer("serviqo")
        .setAudience("serviqo-dashboard")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 60 * 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60 * 60)
        .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!));

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(expired));

      expect(response.status).toBe(401);
    });
  });

  // ---- permissions ----

  describe("permission enforcement", () => {
    it.each([["owner"], ["admin"], ["supervisor"], ["agent"]] as [MembershipRole][])(
      "lets a %s read and reply",
      async (role) => {
        const ctx = buildApp();
        const ownerStaff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, ownerStaff.accessToken, "Acme");
        const { conversationId } = await customerConversation(ctx, organization.id);

        /*
          The creator is already this organization's owner, and
          `membership.model.ts`'s partial unique index enforces at most one —
          so the owner case exercises that existing membership rather than
          inserting a second one that cannot exist.
        */
        const member = role === "owner" ? ownerStaff : await signedInStaff(ctx);
        if (role !== "owner") await addMember(member.userId, organization.id, role);

        const read = await request(ctx.app).get(inboxPath(organization.id)).set(authed(member.accessToken));
        const reply = await request(ctx.app)
          .post(inboxPath(organization.id, `/${conversationId}/messages`))
          .set(authed(member.accessToken))
          .send({ body: `a reply from a ${role}` });

        expect(read.status).toBe(200);
        expect(reply.status).toBe(201);
      },
    );

    it("refuses a member whose membership is not active", async () => {
      const ctx = buildApp();
      const ownerStaff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, ownerStaff.accessToken, "Acme");

      const invited = await signedInStaff(ctx);
      await addMember(invited.userId, organization.id, "agent", "invited");

      const response = await request(ctx.app).get(inboxPath(organization.id)).set(authed(invited.accessToken));

      // 404, not 403: an unaccepted invitation must not confirm the tenant
      // exists (ADR-017 §6).
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("refuses every route when the organization is suspended", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      await OrganizationModel.updateOne({ _id: organization.id }, { status: "suspended" });

      const list = await request(ctx.app).get(inboxPath(organization.id)).set(authed(staff.accessToken));
      const send = await request(ctx.app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(staff.accessToken))
        .send({ body: "should not land" });

      expect(list.status).toBe(404);
      expect(send.status).toBe(404);
      expect(await MessageModel.countDocuments({ senderType: "agent" })).toBe(0);
    });
  });

  // ---- organization isolation ----

  describe("organization isolation", () => {
    it("does not list another organization's conversations", async () => {
      const ctx = buildApp();
      const staffA = await signedInStaff(ctx);
      const staffB = await signedInStaff(ctx);
      const orgA = await createOrganization(ctx, staffA.accessToken, "Acme A");
      const orgB = await createOrganization(ctx, staffB.accessToken, "Acme B");

      await customerConversation(ctx, orgA.id, "A's customer");
      await customerConversation(ctx, orgB.id, "B's customer");

      const listA = await request(ctx.app).get(inboxPath(orgA.id)).set(authed(staffA.accessToken));

      expect(listA.body.data.conversations).toHaveLength(1);

      const historyA = await request(ctx.app)
        .get(inboxPath(orgA.id, `/${listA.body.data.conversations[0].id}/messages`))
        .set(authed(staffA.accessToken));

      expect(historyA.body.data.messages[0].body).toBe("A's customer");
    });

    it("refuses a staff member naming an organization they do not belong to", async () => {
      const ctx = buildApp();
      const staffA = await signedInStaff(ctx);
      const staffB = await signedInStaff(ctx);
      const orgB = await createOrganization(ctx, staffB.accessToken, "Acme B");

      const response = await request(ctx.app).get(inboxPath(orgB.id)).set(authed(staffA.accessToken));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("makes a cross-tenant conversation id indistinguishable from an unknown one", async () => {
      const ctx = buildApp();
      const staffA = await signedInStaff(ctx);
      const staffB = await signedInStaff(ctx);
      const orgA = await createOrganization(ctx, staffA.accessToken, "Acme A");
      const orgB = await createOrganization(ctx, staffB.accessToken, "Acme B");

      const bConversation = await customerConversation(ctx, orgB.id);

      // A real conversation, in another tenant, requested through A's own —
      // authorized — organization path.
      const crossTenant = await request(ctx.app)
        .get(inboxPath(orgA.id, `/${bConversation.conversationId}`))
        .set(authed(staffA.accessToken));

      const unknown = await request(ctx.app)
        .get(inboxPath(orgA.id, `/${UNKNOWN_ID}`))
        .set(authed(staffA.accessToken));

      // Byte-identical apart from the request-scoped envelope metadata
      // (ADR-025 §10).
      expect(crossTenant.status).toBe(unknown.status);
      expect(crossTenant.status).toBe(404);
      expect(crossTenant.body.error.code).toBe(unknown.body.error.code);
      expect(crossTenant.body.error.message).toBe(unknown.body.error.message);
    });

    it("refuses a reply into another tenant's conversation", async () => {
      const ctx = buildApp();
      const staffA = await signedInStaff(ctx);
      const staffB = await signedInStaff(ctx);
      const orgA = await createOrganization(ctx, staffA.accessToken, "Acme A");
      const orgB = await createOrganization(ctx, staffB.accessToken, "Acme B");

      const bConversation = await customerConversation(ctx, orgB.id);

      const response = await request(ctx.app)
        .post(inboxPath(orgA.id, `/${bConversation.conversationId}/messages`))
        .set(authed(staffA.accessToken))
        .send({ body: "should never land" });

      expect(response.status).toBe(404);
      expect(await MessageModel.countDocuments({ senderType: "agent" })).toBe(0);
    });

    it("does not leak another tenant's customer through a conversation row", async () => {
      const ctx = buildApp();
      const staffA = await signedInStaff(ctx);
      const staffB = await signedInStaff(ctx);
      const orgA = await createOrganization(ctx, staffA.accessToken, "Acme A");
      const orgB = await createOrganization(ctx, staffB.accessToken, "Acme B");

      const bConversation = await customerConversation(ctx, orgB.id);

      /*
        A deliberately corrupt row: a conversation inside A pointing at a
        customer inside B. The batched customer lookup is scoped by
        organization (ADR-025 §7), so the row renders with a null customer
        rather than reaching across the tenant boundary.
      */
      const conversation = await ConversationModel.create({
        organizationId: orgA.id,
        customerId: (await ConversationModel.findById(bConversation.conversationId))!.customerId,
      });

      const response = await request(ctx.app).get(inboxPath(orgA.id)).set(authed(staffA.accessToken));

      const row = response.body.data.conversations.find((c: { id: string }) => c.id === conversation._id.toString());
      expect(row.customer).toBeNull();
    });
  });

  // ---- rate limiting ----

  describe("rate limiting", () => {
    it("bounds agent replies with the authenticated write class", async () => {
      const ctx = buildApp({ rateLimiting: true });
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(ctx, organization.id);

      const send = () =>
        request(ctx.app)
          .post(inboxPath(organization.id, `/${conversationId}/messages`))
          .set(authed(staff.accessToken))
          .send({ body: "reply" });

      /*
        The organization creation above already spent one unit of this
        user's write budget, so the loop runs to the limit rather than past
        it and the next call is the one that must be refused.
      */
      for (let i = 0; i < AUTHENTICATED_WRITE_LIMIT; i += 1) await send();

      const refused = await send();

      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe("TOO_MANY_REQUESTS");
    });
  });

  // ---- logging hygiene ----

  describe("logging hygiene", () => {
    it("keeps message bodies, credentials, and customer email out of the logs", async () => {
      const written: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      // Captures anything pino would emit for the duration of this request.
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        written.push(chunk.toString());
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;

      try {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");
        const { conversationId } = await customerConversation(ctx, organization.id);

        await request(ctx.app)
          .post(inboxPath(organization.id, `/${conversationId}/messages`))
          .set(authed(staff.accessToken))
          .send({ body: "A_SECRET_MESSAGE_BODY" });
      } finally {
        process.stdout.write = original;
      }

      const output = written.join("");
      expect(output).not.toContain("A_SECRET_MESSAGE_BODY");
      expect(output).not.toContain(PASSWORD);
      expect(output).not.toContain("grace@example.com");
      expect(output).not.toContain("Bearer ");
    });
  });
});
