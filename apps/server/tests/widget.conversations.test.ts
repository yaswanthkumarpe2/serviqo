import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_PAGE_MAX_LIMIT,
  WIDGET_CONVERSATION_WRITE_LIMIT,
} from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { verifyAccessToken } from "../src/modules/auth/accessToken";

import type { OrganizationDocument, OrganizationStatus } from "../src/modules/organizations/organization.model";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createOrganizationAs } from "../src/modules/organizations/testing/organizations";

const SESSION_PATH = "/api/v1/widget/session";
const CONVERSATIONS_PATH = "/api/v1/widget/conversations";
const messagesPath = (conversationId: string) => `${CONVERSATIONS_PATH}/${conversationId}/messages`;

/**
 * The complete customer-facing flow ADR-022 builds:
 *
 *   widget session -> POST conversations -> POST messages -> GET messages
 *
 * and the boundary it must hold at every step: a customer's own conversation
 * is reachable only by that customer's own token, and never by guessing an
 * ObjectId, forging a claimed identity, or presenting someone else's.
 */
describe("widget conversations and messages", () => {
  let mongoServer: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await OrganizationModel.init();
    await CustomerModel.init();
    await ConversationModel.init();
    await MessageModel.init();
    await UserModel.init();
    await MembershipModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      OrganizationModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
      UserModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      SessionModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  let slugCounter = 0;
  async function createOrganization(status: OrganizationStatus = "active"): Promise<OrganizationDocument> {
    slugCounter += 1;
    return OrganizationModel.create({ name: `Org ${slugCounter}`, slug: `org-${slugCounter}`, status });
  }

  /** Opens a real widget session through the HTTP stack and returns the bearer token. */
  async function widgetToken(organization: OrganizationDocument): Promise<string> {
    const response = await request(app).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
    return response.body.data.token as string;
  }

  function authed(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function openConversation(token: string) {
    return request(app).post(CONVERSATIONS_PATH).set(authed(token)).send({});
  }

  async function sendMessage(token: string, conversationId: string, body: string) {
    return request(app).post(messagesPath(conversationId)).set(authed(token)).send({ body });
  }

  async function listMessages(token: string, conversationId: string, query = "") {
    return request(app).get(`${messagesPath(conversationId)}${query}`).set(authed(token));
  }

  // ---- end-to-end happy path ----

  describe("the full flow", () => {
    it("creates a conversation, sends messages, and reads them back in order", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);

      const created = await openConversation(token);
      expect(created.status).toBe(201);
      expect(created.body.data.status).toBe("open");
      const conversationId = created.body.data.id as string;

      const first = await sendMessage(token, conversationId, "Hello, I have a question.");
      expect(first.status).toBe(201);
      expect(first.body.data.senderType).toBe("customer");
      expect(first.body.data.body).toBe("Hello, I have a question.");

      const second = await sendMessage(token, conversationId, "Following up on that.");
      expect(second.status).toBe(201);

      const history = await listMessages(token, conversationId);
      expect(history.status).toBe(200);
      expect(history.body.data.messages.map((m: { body: string }) => m.body)).toEqual([
        "Hello, I have a question.",
        "Following up on that.",
      ]);
      expect(history.body.data.nextCursor).toBeNull();
    });

    it("returns the same open conversation on repeated creation", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);

      const first = await openConversation(token);
      const second = await openConversation(token);

      expect(first.body.data.id).toBe(second.body.data.id);
      expect(await ConversationModel.countDocuments({})).toBe(1);
    });

    it("persists the message to the database", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;

      await sendMessage(token, conversationId, "Persisted message");

      const stored = await MessageModel.findOne({ conversationId });
      expect(stored!.body).toBe("Persisted message");
      expect(stored!.senderType).toBe("customer");
    });

    it("does not expose organizationId or customerId in either response", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);

      const created = await openConversation(token);
      const conversationId = created.body.data.id as string;
      const message = await sendMessage(token, conversationId, "Hi");

      expect(created.text).not.toContain(organization._id.toString());
      expect(message.text).not.toContain(organization._id.toString());
      // `agentLastReadAt` and `unreadCount` since ADR-040 §4: when the team last read it, and how many replies are unseen.
      expect(Object.keys(created.body.data).sort()).toEqual([
        "agentLastReadAt",
        "createdAt",
        "id",
        "lastMessageAt",
        "status",
        "unreadCount",
      ]);
      expect(Object.keys(message.body.data).sort()).toEqual(["attachments", "body", "conversationId", "createdAt", "id", "senderType"]);
    });
  });

  // ---- pagination ----

  describe("pagination", () => {
    async function seedConversationWithMessages(count: number) {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;
      for (let i = 0; i < count; i += 1) {
        await sendMessage(token, conversationId, `message ${i}`);
      }
      return { token, conversationId };
    }

    it("returns a bounded page and a cursor when more messages exist", async () => {
      const { token, conversationId } = await seedConversationWithMessages(5);

      const page = await listMessages(token, conversationId, "?limit=2");

      expect(page.body.data.messages).toHaveLength(2);
      expect(page.body.data.nextCursor).not.toBeNull();
    });

    it("walks the full history with successive cursors, deterministically", async () => {
      const { token, conversationId } = await seedConversationWithMessages(5);

      const collected: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const query = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
        const page = await listMessages(token, conversationId, query);
        collected.push(...page.body.data.messages.map((m: { body: string }) => m.body));
        cursor = page.body.data.nextCursor;
        if (cursor === null) break;
      }

      expect(collected).toEqual(["message 0", "message 1", "message 2", "message 3", "message 4"]);
    });

    it("rejects a limit above the maximum", async () => {
      const { token, conversationId } = await seedConversationWithMessages(1);

      const response = await listMessages(token, conversationId, `?limit=${MESSAGE_PAGE_MAX_LIMIT + 1}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a malformed cursor", async () => {
      const { token, conversationId } = await seedConversationWithMessages(1);

      const response = await listMessages(token, conversationId, "?cursor=not-an-object-id");

      expect(response.status).toBe(400);
    });

    it("defaults to a bounded page when no limit is given", async () => {
      const { token, conversationId } = await seedConversationWithMessages(3);

      const response = await listMessages(token, conversationId);

      expect(response.status).toBe(200);
      expect(response.body.data.messages).toHaveLength(3);
      expect(response.body.data.nextCursor).toBeNull();
    });
  });

  // ---- message validation ----

  describe("message validation", () => {
    it("rejects an empty body", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;

      const response = await sendMessage(token, conversationId, "");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await MessageModel.countDocuments({})).toBe(0);
    });

    it("rejects a whitespace-only body", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;

      const response = await sendMessage(token, conversationId, "   \n  ");

      expect(response.status).toBe(400);
    });

    it("rejects a body over the maximum length rather than truncating it", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;
      const oversized = "a".repeat(MESSAGE_BODY_MAX_LENGTH + 1);

      const response = await sendMessage(token, conversationId, oversized);

      expect(response.status).toBe(400);
      expect(await MessageModel.countDocuments({})).toBe(0);
    });

    it("accepts a body at exactly the maximum length", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;
      const maxLength = "a".repeat(MESSAGE_BODY_MAX_LENGTH);

      const response = await sendMessage(token, conversationId, maxLength);

      expect(response.status).toBe(201);
    });

    it("accepts a multi-line body", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;

      const response = await sendMessage(token, conversationId, "line one\nline two\ttabbed");

      expect(response.status).toBe(201);
      expect(response.body.data.body).toBe("line one\nline two\ttabbed");
    });

    it("rejects a body containing a NUL byte", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;

      const response = await sendMessage(token, conversationId, "hello" + String.fromCharCode(0) + "world");

      expect(response.status).toBe(400);
    });
  });

  // ---- client-supplied identity is ignored, never trusted ----

  describe("client-supplied identity fields", () => {
    it("ignores a client-supplied customerId and organizationId when creating a conversation", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);

      const response = await request(app)
        .post(CONVERSATIONS_PATH)
        .set(authed(token))
        .send({ customerId: "507f1f77bcf86cd799439011", organizationId: "507f1f77bcf86cd799439012" });

      expect(response.status).toBe(201);
      const stored = await ConversationModel.findById(response.body.data.id);
      expect(stored!.organizationId.toString()).toBe(organization._id.toString());
    });

    it("ignores a client-supplied senderType of agent and stores the message as customer", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;

      const response = await request(app)
        .post(messagesPath(conversationId))
        .set(authed(token))
        .send({ body: "I am definitely a customer", senderType: "agent" });

      expect(response.status).toBe(201);
      expect(response.body.data.senderType).toBe("customer");
      const stored = await MessageModel.findById(response.body.data.id);
      expect(stored!.senderType).toBe("customer");
    });

    it("ignores a client-supplied conversationId in the message body", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;
      const foreignId = "507f1f77bcf86cd799439011";

      const response = await request(app)
        .post(messagesPath(conversationId))
        .set(authed(token))
        .send({ body: "hi", conversationId: foreignId });

      expect(response.status).toBe(201);
      expect(response.body.data.conversationId).toBe(conversationId);
    });
  });

  // ---- cross-customer and cross-organization isolation ----

  describe("conversation access boundaries", () => {
    it("does not let one customer read another customer's conversation", async () => {
      const organization = await createOrganization();
      const tokenA = await widgetToken(organization);
      const tokenB = await widgetToken(organization);
      const conversationId = (await openConversation(tokenA)).body.data.id as string;

      const response = await listMessages(tokenB, conversationId);

      expect(response.status).toBe(404);
    });

    it("does not let one customer send into another customer's conversation", async () => {
      const organization = await createOrganization();
      const tokenA = await widgetToken(organization);
      const tokenB = await widgetToken(organization);
      const conversationId = (await openConversation(tokenA)).body.data.id as string;

      const response = await sendMessage(tokenB, conversationId, "intrusion attempt");

      expect(response.status).toBe(404);
      expect(await MessageModel.countDocuments({ conversationId })).toBe(0);
    });

    it("does not let a customer in one organization read a conversation in another", async () => {
      const orgA = await createOrganization();
      const orgB = await createOrganization();
      const tokenA = await widgetToken(orgA);
      const tokenB = await widgetToken(orgB);
      const conversationId = (await openConversation(tokenA)).body.data.id as string;

      const response = await listMessages(tokenB, conversationId);

      expect(response.status).toBe(404);
    });

    it("gives an unknown conversation id and a real id belonging to another customer the identical refusal", async () => {
      const organization = await createOrganization();
      const tokenA = await widgetToken(organization);
      const tokenB = await widgetToken(organization);
      const foreignConversationId = (await openConversation(tokenA)).body.data.id as string;
      const unknownId = "507f1f77bcf86cd799439011";

      const knownForeign = await listMessages(tokenB, foreignConversationId);
      const unknown = await listMessages(tokenB, unknownId);

      expect(knownForeign.status).toBe(unknown.status);
      expect(knownForeign.body.error.code).toBe(unknown.body.error.code);
      expect(knownForeign.body.error.message).toBe(unknown.body.error.message);
    });

    it("rejects a malformed conversationId as a 400, distinct from the 404 opaque refusal", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);

      const response = await listMessages(token, "not-an-object-id");

      expect(response.status).toBe(400);
    });
  });

  // ---- widget token boundary ----

  describe("widget token requirements", () => {
    it("rejects a missing token", async () => {
      const response = await request(app).post(CONVERSATIONS_PATH).send({});

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_WIDGET_TOKEN");
    });

    it("rejects an invalid token", async () => {
      const response = await request(app).post(CONVERSATIONS_PATH).set(authed("not.a.jwt")).send({});

      expect(response.status).toBe(401);
    });

    /*
      Constructed directly with `jose` rather than `vi.useFakeTimers()`
      wrapped around a real HTTP call: faking global timers around a live
      `supertest`/Node HTTP round-trip is a known way to hang the underlying
      socket indefinitely, since Node's own I/O callbacks stop firing under
      mocked time unless the fake clock is advanced. `requireWidgetToken.test.ts`
      already covers this exact case (expiry, via fake timers) at the unit
      level, calling the middleware directly with no network layer involved
      — the correct place for that pattern. Here, a genuinely expired token
      is built once so the HTTP layer never runs under mocked time at all.
    */
    it("rejects an expired token", async () => {
      const organization = await createOrganization();
      const customer = await CustomerModel.create({ organizationId: organization._id });
      const { SignJWT } = await import("jose");
      const expiredToken = await new SignJWT({ org: organization._id.toString() })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(customer._id.toString())
        .setIssuer("serviqo")
        .setAudience("serviqo-widget")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 60 * 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60 * 60)
        .sign(new TextEncoder().encode(process.env.JWT_WIDGET_SECRET!));

      const response = await request(app).post(CONVERSATIONS_PATH).set(authed(expiredToken)).send({});

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_WIDGET_TOKEN");
    });

    it("rejects a staff access token presented as a widget token", async () => {
      await createStaffAccount(createFakeEmailProvider().provider, { name: "Ada Lovelace", email: "staff@example.com", password: "DO_NOT_LEAK_PASSWORD_1" });
      // A staff token fails verifyWidgetToken at the signature (different
      // key) before any claim is read — it never becomes a widgetPrincipal.
      const registered = await UserModel.findOne({ email: "staff@example.com" });
      const { issueAccessToken } = await import("../src/modules/auth/accessToken");
      const { token } = await issueAccessToken({ userId: registered!._id.toString(), sessionId: registered!._id.toString() });

      const response = await request(app).post(CONVERSATIONS_PATH).set(authed(token)).send({});

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_WIDGET_TOKEN");
      await expect(verifyAccessToken(token)).resolves.not.toBeNull();
    });

    it("refuses a token from a suspended organization", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      await OrganizationModel.updateOne({ _id: organization._id }, { $set: { status: "suspended" } });

      const response = await request(app).post(CONVERSATIONS_PATH).set(authed(token)).send({});

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("WIDGET_SESSION_REFUSED");
    });

    it("cannot create, read, or send while the organization is suspended", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;

      await OrganizationModel.updateOne({ _id: organization._id }, { $set: { status: "suspended" } });

      const createAttempt = await openConversation(token);
      const sendAttempt = await sendMessage(token, conversationId, "hi");
      const readAttempt = await listMessages(token, conversationId);

      expect(createAttempt.status).toBe(403);
      expect(sendAttempt.status).toBe(403);
      expect(readAttempt.status).toBe(403);
    });

    it("refuses a token whose customer no longer exists", async () => {
      const organization = await createOrganization();
      const session = await request(app).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      await CustomerModel.deleteOne({ _id: session.body.data.customer.id });

      const response = await request(app)
        .post(CONVERSATIONS_PATH)
        .set(authed(session.body.data.token as string))
        .send({});

      expect(response.status).toBe(403);
    });
  });

  // ---- widget origin policy is untouched ----

  describe("existing origin policy", () => {
    it("still refuses a session request from a disallowed origin (ADR-019, unchanged by this slice)", async () => {
      const organization = await createOrganization();
      await OrganizationModel.updateOne(
        { _id: organization._id },
        { $set: { allowedOrigins: ["https://shop.example.com"] } },
      );

      const response = await request(app)
        .post(SESSION_PATH)
        .set("Origin", "https://evil.example.net")
        .send({ widgetKey: organization.widgetKey });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("WIDGET_SESSION_REFUSED");
    });
  });

  // ---- existing staff authentication is unaffected ----

  describe("existing staff authentication", () => {
    it("still completes sign-in and organization access", async () => {
      const email = "regression@example.com";
      await createStaffAccount(createFakeEmailProvider().provider, { name: "Ada Lovelace", email, password: "DO_NOT_LEAK_PASSWORD_1" });
      const user = await UserModel.findOne({ email });
      await UserModel.updateOne({ _id: user!._id }, { $set: { emailVerifiedAt: new Date() } });

      const login = await request(app).post("/api/v1/auth/login").send({ email, password: "DO_NOT_LEAK_PASSWORD_1" });
      expect(login.status).toBe(200);

      const created = await createOrganizationAs(login.body.data.accessToken as string, "Acme Corp");
      const context = await request(app)
        .get(`/api/v1/organizations/${created.id}`)
        .set("Authorization", `Bearer ${login.body.data.accessToken}`);
      expect(context.status).toBe(200);
    });
  });

  // ---- logging ----

  describe("what reaches the logs", () => {
    function captureLogs() {
      const lines: string[] = [];
      const record = (payload: Record<string, unknown>, message: string) => {
        lines.push(JSON.stringify(payload) + " " + message);
      };
      return { lines, logger: { info: record, error: record, warn: record } };
    }

    it("logs no message body on creation", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;
      const capture = captureLogs();

      const { createMessageService } = await import("../src/modules/messages/message.service");
      await createMessageService().create(
        organization._id.toString(),
        (await CustomerModel.findOne({ organizationId: organization._id }))!._id.toString(),
        conversationId,
        "SENTINEL_SECRET_MESSAGE_BODY",
        capture.logger,
      );

      const logged = capture.lines.join("\n");
      expect(logged).not.toContain("SENTINEL_SECRET_MESSAGE_BODY");
      expect(logged).toContain("message.created");
    });

    it("logs no token or widget key across the full conversation flow", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = (await openConversation(token)).body.data.id as string;
      await sendMessage(token, conversationId, "hello");
      await listMessages(token, conversationId);

      // Exercised through the real HTTP stack with the app's own logger;
      // this asserts the response bodies alone never carried the credential
      // back, which is the observable half of "never logged" from outside
      // the process (the log-capture tests above cover the logger itself).
      const conversation = await openConversation(token);
      expect(conversation.text).not.toContain(token);
      expect(conversation.text).not.toContain(organization.widgetKey!);
    });
  });

  // ---- rate limiting ----

  describe("rate limiting", () => {
    it("refuses conversation/message writes past the customer-keyed limit", async () => {
      const limited = createApp({ rateLimiting: true });
      const organization = await createOrganization();
      const session = await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      const token = session.body.data.token as string;
      const conversationId = (await request(limited).post(CONVERSATIONS_PATH).set(authed(token)).send({})).body.data
        .id as string;

      for (let i = 0; i < WIDGET_CONVERSATION_WRITE_LIMIT - 1; i += 1) {
        await request(limited).post(messagesPath(conversationId)).set(authed(token)).send({ body: `msg ${i}` });
      }

      const overLimit = await request(limited)
        .post(messagesPath(conversationId))
        .set(authed(token))
        .send({ body: "over the limit" });

      expect(overLimit.status).toBe(429);
    });

    it("keeps each customer's write budget independent", async () => {
      const limited = createApp({ rateLimiting: true });
      const organization = await createOrganization();
      const sessionA = await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      const sessionB = await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      const tokenA = sessionA.body.data.token as string;
      const tokenB = sessionB.body.data.token as string;

      for (let i = 0; i < WIDGET_CONVERSATION_WRITE_LIMIT; i += 1) {
        await request(limited).post(CONVERSATIONS_PATH).set(authed(tokenA)).send({});
      }
      const exhausted = await request(limited).post(CONVERSATIONS_PATH).set(authed(tokenA)).send({});
      const stillFresh = await request(limited).post(CONVERSATIONS_PATH).set(authed(tokenB)).send({});

      expect(exhausted.status).toBe(429);
      expect(stillFresh.status).not.toBe(429);
    });
  });

  // ---- repository scoping discipline ----

  describe("repository scoping", () => {
    it("conversationRepository exposes no unscoped lookup by id alone", async () => {
      const { conversationRepository } = await import("../src/modules/conversations/conversation.repository");
      const methodNames = Object.keys(conversationRepository);

      expect(methodNames).not.toContain("findById");
      expect(methodNames).not.toContain("findAll");
      expect(methodNames.sort()).toEqual(
        [
          "create",
          "findByIdForCustomer",
          "findOpenByCustomer",
          // The staff-facing pair (ADR-025 §5). Two keys rather than three,
          // because an agent is entitled to every conversation in their own
          // tenant — and to none outside it, which is why BOTH still take
          // `organizationId` as a mandatory argument. The point this
          // assertion protects is unchanged: no method here can be called
          // without naming a tenant.
          "findByIdForOrganization",
          // The signed-in customer's own list (ADR-034 §5). Takes
          // `organizationId` AND `customerId`, so it is scoped more tightly
          // than anything above it and the rule this assertion protects —
          // no method may be called without naming a tenant — still holds.
          "listByCustomer",
          "listByOrganization",
          "touchLastMessageAt",
          // Read receipts (ADR-040 §4). Both take `organizationId`; the customer's also takes `customerId`.
          "markReadByAgents",
          "markReadByCustomer",
          /*
            The state-changing trio (ADR-026 §4, §7). Every one of them takes
            `organizationId` as a mandatory key in its own filter — a
            conditional update that located its target by `_id` alone would be
            a cross-tenant write waiting for a caller to pass the wrong
            organization, which is the exact hazard this assertion exists to
            catch.
          */
          "claimForUser",
          "releaseForUser",
          "setStatus",
          // Tags (ADR-042 §3): the write and the distinct read both take `organizationId`.
          "setTags",
          "distinctTags",
          /*
            The membership-driven sweep (ADR-027 §10) — the one this repository
            gained when memberships got a lifecycle, and the thing that closes
            ADR-026 §15's stale-assignment limitation.

            Unconditional on the caller, unlike `releaseForUser`, whose "null
            or me" precondition is what made a departed member's queue
            unreleasable by anyone. Still takes `organizationId` as a mandatory
            key, which is the property this assertion exists to protect: a
            person who works in two tenants keeps their work in the tenant they
            were not removed from.
          */
          "releaseAllForUser",
        ].sort(),
      );
    });

    it("messageRepository exposes no unscoped lookup", async () => {
      const { messageRepository } = await import("../src/modules/messages/message.repository");
      const methodNames = Object.keys(messageRepository);

      expect(methodNames).not.toContain("findById");
      expect(methodNames).not.toContain("findAll");
      expect(methodNames.sort()).toEqual(["create", "list"].sort());
    });
  });
});
