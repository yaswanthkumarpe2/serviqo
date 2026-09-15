import { createServer } from "node:http";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { ATTACHMENT_MAX_BYTES } from "../src/config/constants";
import { redactUrl } from "../src/middleware/requestContext";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { AttachmentModel } from "../src/modules/attachments/attachment.model";
import { sanitizeFileName } from "../src/modules/attachments/fileTypes";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { createOrganizationAs } from "../src/modules/organizations/testing/organizations";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * Files and images in chats (ADR-041): upload, send, download, and every
 * boundary around them.
 */

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const ORG = "/api/v1/organizations";
const WIDGET = "/api/v1/widget/conversations";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);

describe("chat attachments", () => {
  let mongoServer: MongoMemoryServer;
  let httpServer: HttpServer;
  let baseUrl: string;
  const fake = createFakeEmailProvider();
  const app = createApp({ emailProvider: fake.provider });
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      UserModel.init(),
      OrganizationModel.init(),
      MembershipModel.init(),
      CustomerModel.init(),
      ConversationModel.init(),
      MessageModel.init(),
      AttachmentModel.init(),
    ]);
    httpServer = createServer(app);
    createSocketServer(httpServer, { rateLimiting: false });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.close();
    await Promise.all([
      UserModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
      AttachmentModel.deleteMany({}),
      SessionModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- fixtures ----

  let counter = 0;
  async function owner() {
    counter += 1;
    const email = `owner${counter}@example.com`;
    await createStaffAccount(fake.provider, { name: "Olivia Owner", email, password: PASSWORD });
    await request(app).post("/api/v1/auth/verify-email").send({ email, code: fake.verifications.at(-1)!.code });
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    const token = login.body.data.accessToken as string;
    const organization = await createOrganizationAs(token, `Org ${counter}`);
    return { token, organization };
  }

  async function customer(organizationId: string) {
    const organization = await OrganizationModel.findById(organizationId);
    const session = await request(app).post("/api/v1/widget/session").send({ widgetKey: organization!.widgetKey });
    const token = session.body.data.token as string;
    const conversation = await request(app).post(WIDGET).set("Authorization", `Bearer ${token}`).send({});
    return { token, conversationId: conversation.body.data.id as string };
  }

  const uploadAsCustomer = (token: string, conversationId: string, bytes: Buffer, type: string, name = "photo.png") =>
    request(app)
      .post(`${WIDGET}/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", type)
      .set("X-Filename", encodeURIComponent(name))
      .send(bytes);

  const uploadAsAgent = (
    token: string,
    organizationId: string,
    conversationId: string,
    bytes: Buffer,
    type: string,
    name = "invoice.pdf",
  ) =>
    request(app)
      .post(`${ORG}/${organizationId}/conversations/${conversationId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", type)
      .set("X-Filename", encodeURIComponent(name))
      .send(bytes);

  const sendAsCustomer = (token: string, conversationId: string, body: object) =>
    request(app).post(`${WIDGET}/${conversationId}/messages`).set("Authorization", `Bearer ${token}`).send(body);

  const download = (url: string) =>
    request(app)
      .get(url)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

  // ---- the happy path ----

  describe("a visitor sending a picture", () => {
    it("uploads, sends it with no text, and both sides can open it", async () => {
      const { token: ownerToken, organization } = await owner();
      const visitor = await customer(organization.id);

      const uploaded = await uploadAsCustomer(visitor.token, visitor.conversationId, PNG, "image/png", "my screenshot.png");
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.data).toMatchObject({ name: "my screenshot.png", contentType: "image/png", size: PNG.length });
      expect(uploaded.body.data.url).toMatch(/^\/api\/v1\/files\/[0-9a-f]{24}\/my%20screenshot\.png\?key=[A-Za-z0-9_-]{43}$/);

      // Not downloadable until it is actually sent.
      expect((await download(uploaded.body.data.url)).status).toBe(404);

      const sent = await sendAsCustomer(visitor.token, visitor.conversationId, { attachmentIds: [uploaded.body.data.id] });
      expect(sent.status).toBe(201);
      expect(sent.body.data.body).toBe("");
      expect(sent.body.data.attachments).toEqual([uploaded.body.data]);

      const history = await request(app)
        .get(`${ORG}/${organization.id}/conversations/${visitor.conversationId}/messages`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(history.body.data.messages[0].attachments[0].url).toBe(uploaded.body.data.url);
      expect(JSON.stringify(history.body)).not.toContain("accessKey");

      const file = await download(uploaded.body.data.url);
      expect(file.status).toBe(200);
      expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
      expect(file.headers["content-type"]).toBe("image/png");
      expect(file.headers["content-disposition"]).toContain("inline");
      expect(file.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect(file.headers["content-security-policy"]).toContain("sandbox");
      expect(file.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("sends text and files together, over the socket too", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);
      const uploaded = await uploadAsCustomer(visitor.token, visitor.conversationId, PNG, "image/png");

      const socket = ioClient(baseUrl, { auth: { token: visitor.token }, transports: ["websocket"], forceNew: true, reconnection: false });
      openSockets.push(socket);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      await new Promise<void>((resolve) => socket.emit("conversation:join", { conversationId: visitor.conversationId }, () => resolve()));

      const ack = await new Promise<{ ok: boolean; data: { body: string; attachments: { id: string }[] } }>((resolve) =>
        socket.emit(
          "message:send",
          { conversationId: visitor.conversationId, body: "here it is", attachmentIds: [uploaded.body.data.id] },
          resolve,
        ),
      );

      expect(ack.ok).toBe(true);
      expect(ack.data.body).toBe("here it is");
      expect(ack.data.attachments.map((a) => a.id)).toEqual([uploaded.body.data.id]);
    });
  });

  describe("an agent sending a document", () => {
    it("is offered as a download, not shown inline", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);

      const uploaded = await uploadAsAgent(token, organization.id, visitor.conversationId, PDF, "application/pdf");
      expect(uploaded.status).toBe(201);

      const sent = await request(app)
        .post(`${ORG}/${organization.id}/conversations/${visitor.conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body: "Your invoice", attachmentIds: [uploaded.body.data.id] });
      expect(sent.status).toBe(201);

      const history = await request(app)
        .get(`${WIDGET}/${visitor.conversationId}/messages`)
        .set("Authorization", `Bearer ${visitor.token}`);
      const attachment = history.body.data.messages[0].attachments[0];
      expect(attachment.name).toBe("invoice.pdf");

      const file = await download(attachment.url);
      expect(file.status).toBe(200);
      expect(file.headers["content-disposition"]).toMatch(/^attachment; filename="invoice.pdf"/);
    });
  });

  // ---- what may be uploaded ----

  describe("what can be uploaded", () => {
    it("refuses HTML, SVG and anything not on the list", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);

      for (const [bytes, type] of [
        [Buffer.from("<script>alert(1)</script>"), "text/html"],
        [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"],
        [Buffer.from("MZ"), "application/octet-stream"],
      ] as const) {
        const response = await uploadAsCustomer(visitor.token, visitor.conversationId, bytes, type);
        expect(response.status).toBe(400);
      }
    });

    it("refuses a file whose bytes do not match its type", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);

      const response = await uploadAsCustomer(visitor.token, visitor.conversationId, Buffer.from("<html>"), "image/png");

      expect(response.status).toBe(400);
      expect(await AttachmentModel.countDocuments()).toBe(0);
    });

    it("refuses an empty file and one over the size limit", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);

      expect((await uploadAsCustomer(visitor.token, visitor.conversationId, Buffer.alloc(0), "image/png")).status).toBe(400);

      const tooBig = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_BYTES)]);
      const response = await uploadAsCustomer(visitor.token, visitor.conversationId, tooBig, "image/png");
      expect(response.status).toBe(413);
    });

    it("cleans file names", () => {
      expect(sanitizeFileName("..%2F..%2Fetc%2Fpasswd", "txt")).toBe("passwd");
      expect(sanitizeFileName('a"b<c>.png', "png")).toBe("abc.png");
      expect(sanitizeFileName("", "png")).toBe("file.png");
      expect(sanitizeFileName(`${"x".repeat(300)}.pdf`, "pdf")).toHaveLength(120);
    });
  });

  // ---- boundaries ----

  describe("boundaries", () => {
    it("will not let one visitor send, or upload into, another visitor's conversation", async () => {
      const { organization } = await owner();
      const alice = await customer(organization.id);
      const bob = await customer(organization.id);

      const alicesFile = await uploadAsCustomer(alice.token, alice.conversationId, PNG, "image/png");

      expect((await uploadAsCustomer(bob.token, alice.conversationId, PNG, "image/png")).status).toBe(404);

      const borrowed = await sendAsCustomer(bob.token, bob.conversationId, { attachmentIds: [alicesFile.body.data.id] });
      expect(borrowed.status).toBe(400);
      expect(await MessageModel.countDocuments()).toBe(0);

      // Still Alice's to send.
      expect((await sendAsCustomer(alice.token, alice.conversationId, { attachmentIds: [alicesFile.body.data.id] })).status).toBe(201);
    });

    it("sends a file once, and refuses the whole message if any file is not sendable", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);
      const first = await uploadAsCustomer(visitor.token, visitor.conversationId, PNG, "image/png");
      const second = await uploadAsCustomer(visitor.token, visitor.conversationId, PNG, "image/png");

      expect((await sendAsCustomer(visitor.token, visitor.conversationId, { attachmentIds: [first.body.data.id] })).status).toBe(201);

      const again = await sendAsCustomer(visitor.token, visitor.conversationId, {
        attachmentIds: [second.body.data.id, first.body.data.id],
      });
      expect(again.status).toBe(400);

      // The failed send did not consume the second file.
      const retry = await sendAsCustomer(visitor.token, visitor.conversationId, { attachmentIds: [second.body.data.id] });
      expect(retry.status).toBe(201);
    });

    it("does not let an agent send a file the visitor uploaded", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      const visitorsFile = await uploadAsCustomer(visitor.token, visitor.conversationId, PNG, "image/png");

      const response = await request(app)
        .post(`${ORG}/${organization.id}/conversations/${visitor.conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ attachmentIds: [visitorsFile.body.data.id] });

      expect(response.status).toBe(400);
    });

    it("gives another organisation's staff the same 404 as a missing conversation", async () => {
      const a = await owner();
      const b = await owner();
      const visitor = await customer(a.organization.id);

      const crossTenant = await uploadAsAgent(b.token, b.organization.id, visitor.conversationId, PDF, "application/pdf");
      expect(crossTenant.status).toBe(404);

      const wrongOrg = await uploadAsAgent(b.token, a.organization.id, visitor.conversationId, PDF, "application/pdf");
      expect(wrongOrg.status).toBe(404);
    });

    it("refuses uploads into a closed conversation", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      await request(app)
        .patch(`${ORG}/${organization.id}/conversations/${visitor.conversationId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "closed" });

      const response = await uploadAsCustomer(visitor.token, visitor.conversationId, PNG, "image/png");

      expect(response.status).toBe(409);
    });

    it("requires a visitor token or staff sign-in to upload", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);

      const response = await request(app)
        .post(`${WIDGET}/${visitor.conversationId}/attachments`)
        .set("Content-Type", "image/png")
        .send(PNG);

      expect(response.status).toBe(401);
    });

    it("answers a wrong key with the same 404 as a missing file", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);
      const uploaded = await uploadAsCustomer(visitor.token, visitor.conversationId, PNG, "image/png");
      await sendAsCustomer(visitor.token, visitor.conversationId, { attachmentIds: [uploaded.body.data.id] });

      const wrongKey = (uploaded.body.data.url as string).replace(/key=.*/, `key=${"A".repeat(43)}`);
      const missing = `/api/v1/files/${new mongoose.Types.ObjectId().toString()}/x.png?key=${"A".repeat(43)}`;

      const [a, b, c] = await Promise.all([download(wrongKey), download(missing), download("/api/v1/files/nope")]);
      expect([a.status, b.status, c.status]).toEqual([404, 404, 404]);
    });

    it("still refuses a message with neither text nor files", async () => {
      const { organization } = await owner();
      const visitor = await customer(organization.id);

      const response = await sendAsCustomer(visitor.token, visitor.conversationId, { body: "   ", attachmentIds: [] });

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe("body");
    });
  });

  describe("the widget's cross-origin upload", () => {
    it("allows the file name header in the preflight", async () => {
      const response = await request(app)
        .options(`${WIDGET}/${new mongoose.Types.ObjectId().toString()}/attachments`)
        .set("Origin", "https://shop.example");

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-headers"]).toContain("X-Filename");
    });
  });

  it("keeps file keys out of request logs", () => {
    expect(redactUrl("/api/v1/files/abc/x.png?key=SECRET&v=1")).toBe("/api/v1/files/abc/x.png?key=[redacted]&v=1");
  });
});
