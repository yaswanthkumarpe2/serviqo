import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { sha256 } from "../src/lib/crypto/tokens";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";

import type { OrganizationDocument, OrganizationStatus } from "../src/modules/organizations/organization.model";

/**
 * One chat link per organisation (ADR-038).
 *
 * A customer opens `/widget/<slug>`, is connected to that organisation and no
 * other, and can come back next week to the same conversation without ever
 * holding an account. These tests pin the four pieces that make that true:
 * the directory lookup behind the link, Serviqo's own origin being allowed to
 * open sessions, the long-lived visitor key, and the link being shown to every
 * member of the organisation.
 */

const DIRECTORY_PATH = "/api/v1/widget/organizations";
const SESSION_PATH = "/api/v1/widget/session";
const CONVERSATIONS_PATH = "/api/v1/widget/conversations";
const LOGIN_PATH = "/api/v1/auth/login";
const VERIFY_PATH = "/api/v1/auth/verify-email";

/** Matches `CLIENT_URL` in `tests/setup.ts`: the origin the hosted page is served from. */
const SERVIQO_ORIGIN = "http://localhost:5173";
const THIRD_PARTY_ORIGIN = "https://evil.example.net";
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

describe("organisation chat links", () => {
  let mongoServer: MongoMemoryServer;
  const fake = createFakeEmailProvider();
  const app = createApp({ emailProvider: fake.provider });

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      OrganizationModel.init(),
      CustomerModel.init(),
      ConversationModel.init(),
      UserModel.init(),
      MembershipModel.init(),
      SessionModel.init(),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      OrganizationModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      UserModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      SessionModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  /*
    Per test, not per file: the database is emptied after every test, so the
    first organisation in each one may take its plain slug.
  */
  let counter = 0;
  afterEach(() => {
    counter = 0;
  });

  async function createOrganization(
    name = "CentralService",
    slug = "centralservice",
    status: OrganizationStatus = "active",
  ): Promise<OrganizationDocument> {
    counter += 1;
    return OrganizationModel.create({ name, slug: counter === 1 ? slug : `${slug}-${counter}`, status, allowedOrigins: [] });
  }

  const openSession = (body: Record<string, unknown>, origin = SERVIQO_ORIGIN) =>
    request(app).post(SESSION_PATH).set("Origin", origin).send(body);

  // ---- the directory lookup ----

  describe("GET /widget/organizations/:slug", () => {
    it("answers the organisation's name and widget key, and nothing else", async () => {
      const organization = await OrganizationModel.create({ name: "CentralService", slug: "centralservice" });

      const response = await request(app).get(`${DIRECTORY_PATH}/centralservice`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ name: "CentralService", widgetKey: organization.widgetKey });
    });

    it("matches the slug case-insensitively, as links get retyped", async () => {
      await OrganizationModel.create({ name: "CentralService", slug: "centralservice" });

      expect((await request(app).get(`${DIRECTORY_PATH}/CentralService`)).status).toBe(200);
    });

    it("answers unknown, malformed and suspended slugs with one identical 404", async () => {
      await OrganizationModel.create({ name: "Paused", slug: "paused", status: "suspended" });

      const unknown = await request(app).get(`${DIRECTORY_PATH}/no-such-organisation`);
      const malformed = await request(app).get(`${DIRECTORY_PATH}/${encodeURIComponent("not a slug!")}`);
      const suspended = await request(app).get(`${DIRECTORY_PATH}/paused`);

      for (const response of [unknown, malformed, suspended]) {
        expect(response.status).toBe(404);
        expect(response.body.error.message).toBe(unknown.body.error.message);
      }
    });

    it("has no route that lists organisations", async () => {
      await OrganizationModel.create({ name: "CentralService", slug: "centralservice" });

      expect((await request(app).get(DIRECTORY_PATH)).status).toBe(404);
    });

    it("mints a widget key for an organisation that predates them", async () => {
      await OrganizationModel.collection.insertOne({
        name: "Old Org",
        slug: "old-org",
        status: "active",
        widgetKey: null,
        allowedOrigins: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(app).get(`${DIRECTORY_PATH}/old-org`);

      expect(response.status).toBe(200);
      expect(response.body.data.widgetKey).toEqual(expect.any(String));
    });
  });

  // ---- the link's own origin ----

  describe("sessions opened from Serviqo's own page", () => {
    it("are allowed even when the organisation lists no embed origins", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey }, SERVIQO_ORIGIN);

      expect(response.status).toBe(201);
    });

    it("do not open the door to third-party pages", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey }, THIRD_PARTY_ORIGIN);

      expect(response.status).toBe(403);
    });

    it("connect the customer to exactly the organisation the link named", async () => {
      const central = await createOrganization("CentralService", "centralservice");
      const other = await createOrganization("Other", "other");

      const session = await openSession({ widgetKey: central.widgetKey });
      const conversation = await request(app)
        .post(CONVERSATIONS_PATH)
        .set("Authorization", `Bearer ${session.body.data.token}`)
        .send({});

      const stored = await ConversationModel.findById(conversation.body.data.id);
      expect(stored!.organizationId.toString()).toBe(central._id.toString());
      expect(stored!.organizationId.toString()).not.toBe(other._id.toString());
    });
  });

  // ---- continuing without an account ----

  describe("the visitor key", () => {
    it("is issued once to a new visitor, and only its hash is stored", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });
      const visitorKey = response.body.data.visitorKey as string;

      expect(visitorKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = await CustomerModel.findById(response.body.data.customer.id).select("+visitorKeyHash");
      expect(stored!.visitorKeyHash).toBe(sha256(visitorKey));
      expect(JSON.stringify(stored!.toJSON())).not.toContain(visitorKey);
    });

    it("continues the same customer and conversation after the token is gone", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey });
      const conversation = await request(app)
        .post(CONVERSATIONS_PATH)
        .set("Authorization", `Bearer ${first.body.data.token}`)
        .send({});

      // A week later: the one-day token has expired and the browser offers only its key.
      const later = await openSession({ widgetKey: organization.widgetKey, visitorKey: first.body.data.visitorKey });
      const resumed = await request(app)
        .post(CONVERSATIONS_PATH)
        .set("Authorization", `Bearer ${later.body.data.token}`)
        .send({});

      expect(later.body.data.customer.id).toBe(first.body.data.customer.id);
      expect(resumed.body.data.id).toBe(conversation.body.data.id);
      expect(await CustomerModel.countDocuments({})).toBe(1);
    });

    it("is not sent again once the browser holds it", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey });

      const later = await openSession({ widgetKey: organization.widgetKey, visitorKey: first.body.data.visitorKey });

      expect(later.body.data.visitorKey).toBeUndefined();
    });

    it("resumes nothing in another organisation", async () => {
      const central = await createOrganization("CentralService", "centralservice");
      const other = await createOrganization("Other", "other");
      const first = await openSession({ widgetKey: central.widgetKey });

      const elsewhere = await openSession({ widgetKey: other.widgetKey, visitorKey: first.body.data.visitorKey });

      expect(elsewhere.status).toBe(201);
      expect(elsewhere.body.data.customer.id).not.toBe(first.body.data.customer.id);
      const created = await CustomerModel.findById(elsewhere.body.data.customer.id);
      expect(created!.organizationId.toString()).toBe(other._id.toString());
    });

    it("treats an unknown key as a new visitor rather than an error", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, visitorKey: "A".repeat(43) });

      expect(response.status).toBe(201);
      expect(response.body.data.visitorKey).toEqual(expect.any(String));
    });

    it("refuses a malformed key at the boundary", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, visitorKey: "short" });

      expect(response.status).toBe(400);
    });

    it("is minted for a customer from before visitor keys, on their next session", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey });
      await CustomerModel.updateOne({ _id: first.body.data.customer.id }, { $set: { visitorKeyHash: null } });

      const later = await openSession({ widgetKey: organization.widgetKey, visitorToken: first.body.data.token });

      expect(later.body.data.customer.id).toBe(first.body.data.customer.id);
      expect(later.body.data.visitorKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  // ---- optional details ----

  describe("optional contact details", () => {
    it("stores a phone number the visitor chose to give", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, name: "Priya", phone: "+44 20 7946 0958" });

      expect(response.body.data.customer).toMatchObject({ name: "Priya", phone: "+44 20 7946 0958", email: null });
    });

    it("needs none of them", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.status).toBe(201);
      expect(response.body.data.customer).toMatchObject({ name: null, email: null, phone: null });
    });

    it("refuses something that is not a phone number", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, phone: "call me\nmaybe" });

      expect(response.status).toBe(400);
    });
  });

  // ---- who sees the link ----

  describe("the link, as staff see it", () => {
    async function signedInMember(organization: OrganizationDocument, role: "owner" | "agent") {
      const email = `${role}-${counter}@example.com`;
      const account = await createStaffAccount(fake.provider, { name: "Ada Lovelace", email, password: PASSWORD });
      await request(app).post(VERIFY_PATH).send({ email, code: fake.verifications.at(-1)!.code });
      await MembershipModel.create({
        userId: account.id,
        organizationId: organization._id,
        role,
        status: "active",
        invitedByUserId: null,
      });
      const login = await request(app).post(LOGIN_PATH).send({ email, password: PASSWORD });
      return login.body.data.accessToken as string;
    }

    it("is shown to an agent on the organisation read", async () => {
      const organization = await createOrganization();
      const token = await signedInMember(organization, "agent");

      const response = await request(app)
        .get(`/api/v1/organizations/${organization._id.toString()}`)
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.organization.widgetUrl).toBe("http://localhost:5173/widget/centralservice");
    });

    it("sits beside the embed settings an admin manages", async () => {
      const organization = await createOrganization();
      const token = await signedInMember(organization, "owner");

      const response = await request(app)
        .get(`/api/v1/organizations/${organization._id.toString()}/widget-config`)
        .set("Authorization", `Bearer ${token}`);

      expect(response.body.data.widgetUrl).toBe("http://localhost:5173/widget/centralservice");
    });
  });

  // ---- the link's permanence ----

  describe("the slug", () => {
    it("cannot be changed once the organisation exists, so links never break", async () => {
      const organization = await createOrganization();

      organization.slug = "renamed";
      await organization.save();

      expect((await OrganizationModel.findById(organization._id))!.slug).toBe("centralservice");
    });
  });
});
