import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { organizationRepository } from "../src/modules/organizations/organization.repository";
import { isWellFormedWidgetKey } from "../src/modules/organizations/widgetConfig";

/**
 * An organization's public widget configuration (ADR-019 §9, §9a, §10).
 *
 * Two properties this suite exists to prove, both of which are the kind that
 * only fail in production: that every organization created from now on gets a
 * key without anyone remembering to ask, and that organizations written
 * BEFORE this slice still work.
 */
describe("organization widget configuration", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await OrganizationModel.init();
  });

  afterEach(async () => {
    await OrganizationModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe("widgetKey generation", () => {
    it("gives every new organization a key without being asked", async () => {
      const organization = await organizationRepository.create({ name: "Acme Corp", slug: "acme-corp" });

      expect(organization.widgetKey).not.toBeNull();
      expect(isWellFormedWidgetKey(organization.widgetKey!)).toBe(true);
    });

    it("gives two organizations two different keys", async () => {
      const a = await organizationRepository.create({ name: "Org A", slug: "org-a" });
      const b = await organizationRepository.create({ name: "Org B", slug: "org-b" });

      expect(a.widgetKey).not.toBe(b.widgetKey);
    });

    /*
      A key derived from the slug would be a public value dressed as a random
      one, and a key derived from `_id` would publish an internal MongoDB
      identifier into every tenant's page source (ADR-019 §9).
    */
    it("derives the key from neither the name, the slug, nor the id", async () => {
      const organization = await organizationRepository.create({
        name: "Acme Corporation",
        slug: "acme-corporation",
      });
      const key = organization.widgetKey!;

      expect(key).not.toContain("acme");
      expect(key.toLowerCase()).not.toContain("corporation");
      expect(key).not.toContain(organization._id.toString());
      expect(key).not.toContain(organization.slug);
    });

    it("produces distinct keys across many organizations", async () => {
      const created = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          organizationRepository.create({ name: `Org ${i}`, slug: `org-${i}` }),
        ),
      );

      expect(new Set(created.map((o) => o.widgetKey)).size).toBe(50);
    });

    it("starts every organization with a closed origin list", async () => {
      const organization = await organizationRepository.create({ name: "Acme", slug: "acme" });

      expect(organization.allowedOrigins).toEqual([]);
    });
  });

  describe("widgetKey uniqueness", () => {
    it("refuses a second organization with the same key", async () => {
      const first = await organizationRepository.create({ name: "Org A", slug: "org-a" });

      await expect(
        OrganizationModel.create({ name: "Org B", slug: "org-b", widgetKey: first.widgetKey }),
      ).rejects.toThrow();
    });

    it("declares the index as unique and partial", async () => {
      const indexes = await OrganizationModel.collection.indexes();
      const widgetIndex = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ widgetKey: 1 }));

      expect(widgetIndex).toBeDefined();
      expect(widgetIndex!.unique).toBe(true);
      expect(widgetIndex!.partialFilterExpression).toEqual({ widgetKey: { $type: "string" } });
    });
  });

  /*
    The compatibility case that would otherwise have broken every existing
    deployment (ADR-019 §9a).

    MongoDB indexes a missing field as `null`, so a plain `unique: true` would
    treat every pre-Slice-20 organization as colliding with every other one on
    the value `null`. These write documents with the field genuinely absent,
    the way a pre-existing one is.
  */
  describe("organizations written before this slice", () => {
    async function insertLegacyOrganization(name: string, slug: string) {
      await OrganizationModel.collection.insertOne({
        name,
        slug,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
      });
    }

    it("accepts a second organization that has no widgetKey", async () => {
      await insertLegacyOrganization("Legacy One", "legacy-one");

      await expect(insertLegacyOrganization("Legacy Two", "legacy-two")).resolves.toBeUndefined();
      expect(await OrganizationModel.countDocuments({})).toBe(2);
    });

    it("leaves a key-less organization readable and unbroken", async () => {
      await insertLegacyOrganization("Legacy", "legacy");

      const found = await organizationRepository.findBySlug("legacy");

      expect(found).not.toBeNull();
      expect(found!.status).toBe("active");
      expect(found!.widgetKey ?? null).toBeNull();
      // The array field is absent on the document; reading it must not throw.
      expect(found!.allowedOrigins ?? []).toEqual([]);
    });

    /*
      The trap `default: generateWidgetKey` would have set (ADR-019 §9a).

      Mongoose applies schema defaults when HYDRATING a document, not only
      when creating one — so a generator as the default would have
      materialized a fresh random key on every read of a legacy organization,
      a different one each time and none of them persisted. The installation
      surface would then show a staff member a key, they would embed it, and
      nothing would ever find it.
    */
    it("reads a key-less organization back as null, identically every time", async () => {
      await insertLegacyOrganization("Legacy", "legacy");

      const first = await organizationRepository.findBySlug("legacy");
      const second = await organizationRepository.findBySlug("legacy");

      expect(first!.widgetKey).toBeNull();
      expect(second!.widgetKey).toBeNull();
      expect(first!.widgetKey).toBe(second!.widgetKey);
    });

    it("does not persist a key by merely reading a legacy organization", async () => {
      await insertLegacyOrganization("Legacy", "legacy");
      await organizationRepository.findBySlug("legacy");

      const raw = await OrganizationModel.collection.findOne({ slug: "legacy" });

      expect(raw).not.toHaveProperty("widgetKey");
    });

    it("does not reach a key-less organization through the widget", async () => {
      await insertLegacyOrganization("Legacy", "legacy");

      // "No widget yet" is a correct and inert state, not a broken one.
      expect(await organizationRepository.findByWidgetKey("wk_" + "a".repeat(43))).toBeNull();
    });

    it("lets a key-less organization coexist with keyed ones", async () => {
      await insertLegacyOrganization("Legacy", "legacy");
      const modern = await organizationRepository.create({ name: "Modern", slug: "modern" });

      const found = await organizationRepository.findByWidgetKey(modern.widgetKey!);

      expect(found!._id.toString()).toBe(modern._id.toString());
    });
  });

  describe("findByWidgetKey", () => {
    it("resolves the organization that owns a key", async () => {
      const organization = await organizationRepository.create({ name: "Acme", slug: "acme" });

      const found = await organizationRepository.findByWidgetKey(organization.widgetKey!);

      expect(found!._id.toString()).toBe(organization._id.toString());
    });

    it("returns null for a key nobody owns", async () => {
      await organizationRepository.create({ name: "Acme", slug: "acme" });

      expect(await organizationRepository.findByWidgetKey(`wk_${"z".repeat(43)}`)).toBeNull();
    });

    /*
      A widget key is a random base64url string and is CASE-SENSITIVE.
      Lowercasing it the way `findBySlug` lowercases a slug would silently
      fail to find three quarters of all keys.
    */
    it("treats the key as case-sensitive", async () => {
      const organization = await organizationRepository.create({ name: "Acme", slug: "acme" });
      const key = organization.widgetKey!;
      const flipped = key.slice(0, 3) + key.slice(3).split("").reverse().join("");

      expect(await organizationRepository.findByWidgetKey(flipped)).toBeNull();
    });

    it("does not resolve a tenant from a mongo operator", async () => {
      await organizationRepository.create({ name: "Acme", slug: "acme" });

      expect(await organizationRepository.findByWidgetKey('{"$ne":null}')).toBeNull();
    });
  });

  describe("allowedOrigins validation", () => {
    /*
      Written through the model rather than the repository, because nothing in
      this slice configures origins: no staff endpoint exposes them yet
      (ADR-019 §14). Adding an `allowedOrigins` parameter to
      `CreateOrganizationInput` that only a test passes would be the
      speculative surface this codebase declines everywhere else.
    */
    let counter = 0;
    async function withOrigins(allowedOrigins: string[]) {
      counter += 1;
      return OrganizationModel.create({ name: "Acme", slug: `acme-${counter}`, allowedOrigins });
    }

    it("accepts a list of http(s) origins", async () => {
      const organization = await withOrigins(["https://shop.example.com", "http://localhost:5173"]);

      expect(organization.allowedOrigins).toEqual(["https://shop.example.com", "http://localhost:5173"]);
    });

    it("accepts an empty list, which means closed", async () => {
      const organization = await withOrigins([]);

      expect(organization.allowedOrigins).toEqual([]);
    });

    /*
      One origin must not be storable in two spellings, or the request-time
      comparison becomes a coin flip on how a tenant typed it.
    */
    it("canonicalizes on assignment", async () => {
      const organization = await withOrigins(["HTTPS://Shop.Example.COM:443/", "http://Localhost:80"]);

      expect(organization.allowedOrigins).toEqual(["https://shop.example.com", "http://localhost"]);
    });

    it.each([
      ["a bare wildcard", "*"],
      ["a subdomain wildcard", "https://*.example.com"],
      ["a scheme-wide wildcard", "https://*"],
    ])("rejects %s", async (_label, origin) => {
      await expect(withOrigins([origin])).rejects.toThrow(/allowedOrigins/);
    });

    it.each([
      ["a URL with a path", "https://shop.example.com/embed"],
      ["a URL with a query", "https://shop.example.com?a=b"],
      ["a URL with a fragment", "https://shop.example.com#chat"],
      ["userinfo", "https://user:pass@shop.example.com"],
      ["a non-http scheme", "ftp://files.example.com"],
      ["a javascript url", "javascript:alert(1)"],
      ["a bare hostname", "shop.example.com"],
      ["nonsense", "not an origin"],
      ["an empty string", ""],
      ["the literal null", "null"],
    ])("rejects %s", async (_label, origin) => {
      await expect(withOrigins([origin])).rejects.toThrow(/allowedOrigins/);
    });

    it("rejects the whole list when one entry is invalid", async () => {
      await expect(withOrigins(["https://good.example.com", "https://*.bad.example.com"])).rejects.toThrow(
        /allowedOrigins/,
      );
    });
  });

  /*
    The widget key is designed to be public — it appears in the tenant's own
    page source — but nothing in this slice reads it back to anyone, which is
    a deliberate gap recorded in ADR-019 §14 rather than an oversight.
  */
  describe("existing organization behaviour", () => {
    it("still derives slugs and enforces their uniqueness", async () => {
      await organizationRepository.create({ name: "Acme", slug: "acme" });

      await expect(organizationRepository.create({ name: "Acme Two", slug: "acme" })).rejects.toThrow();
    });

    it("still defaults status to active", async () => {
      const organization = await organizationRepository.create({ name: "Acme", slug: "acme" });

      expect(organization.status).toBe("active");
    });
  });
});
