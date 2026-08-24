import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OrganizationModel } from "./organization.model";
import { organizationRepository } from "./organization.repository";
import { isWellFormedWidgetKey } from "./widgetConfig";

describe("Organization persistence", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // Index creation is async; wait for it so the uniqueness tests below
    // are actually exercising the real constraint, not a race with it.
    await OrganizationModel.init();
  });

  afterEach(async () => {
    await OrganizationModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it("creates an organization", async () => {
    const org = await organizationRepository.create({ name: "Acme Support", slug: "acme-support" });

    expect(org._id).toBeDefined();
    expect(org.name).toBe("Acme Support");
    expect(org.slug).toBe("acme-support");
  });

  it("requires a name", async () => {
    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      organizationRepository.create({ slug: "no-name" }),
    ).rejects.toThrow(/name/);
  });

  it("trims the name without changing its case", async () => {
    const org = await organizationRepository.create({ name: "  Acme Support  ", slug: "trim-name" });
    expect(org.name).toBe("Acme Support");
  });

  it("requires a slug", async () => {
    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      organizationRepository.create({ name: "No Slug Org" }),
    ).rejects.toThrow(/slug/);
  });

  it("stores the slug canonically (trimmed and lowercased)", async () => {
    const org = await organizationRepository.create({ name: "Canonical Co", slug: "  Canonical-Co  " });
    expect(org.slug).toBe("canonical-co");
  });

  it("rejects a duplicate slug at the database level", async () => {
    await organizationRepository.create({ name: "First", slug: "dup-slug" });

    await expect(organizationRepository.create({ name: "Second", slug: "dup-slug" })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("treats case variants of the same slug as one identity", async () => {
    await organizationRepository.create({ name: "Acme", slug: "Acme-Support" });

    await expect(organizationRepository.create({ name: "Acme Again", slug: "acme-support" })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("rejects malformed slugs instead of silently transforming them", async () => {
    await expect(organizationRepository.create({ name: "Spaces", slug: "acme support" })).rejects.toThrow();
    await expect(organizationRepository.create({ name: "Slash", slug: "acme/support" })).rejects.toThrow();
    await expect(organizationRepository.create({ name: "Underscore", slug: "acme_support" })).rejects.toThrow();
    await expect(organizationRepository.create({ name: "Question", slug: "acme?test" })).rejects.toThrow();
  });

  it("finds an organization by id", async () => {
    const created = await organizationRepository.create({ name: "By Id", slug: "by-id" });
    const found = await organizationRepository.findById(created._id.toString());
    expect(found?.slug).toBe("by-id");
  });

  it("finds an organization by slug using normalizable input", async () => {
    const created = await organizationRepository.create({ name: "Find Me", slug: "find-me" });
    const found = await organizationRepository.findBySlug("  FIND-ME  ");
    expect(found?._id.toString()).toBe(created._id.toString());
  });

  it("defaults status to active", async () => {
    const org = await organizationRepository.create({ name: "Status Co", slug: "status-co" });
    expect(org.status).toBe("active");
  });

  it("rejects an invalid status", async () => {
    await expect(
      OrganizationModel.create({
        name: "Bad Status",
        slug: "bad-status",
        // @ts-expect-error -- intentionally invalid enum value to prove validation rejects it.
        status: "deleted",
      }),
    ).rejects.toThrow();
  });

  it("sets createdAt and updatedAt on create", async () => {
    const org = await organizationRepository.create({ name: "Timestamps", slug: "timestamps-org" });
    expect(org.createdAt).toBeInstanceOf(Date);
    expect(org.updatedAt).toBeInstanceOf(Date);
  });

  it("has no ownerUserId, role, or membership data", async () => {
    const org = await organizationRepository.create({
      name: "No Tenant Coupling",
      slug: "no-tenant-coupling",
    });

    const plain = org.toObject();
    expect(plain).not.toHaveProperty("ownerUserId");
    expect(plain).not.toHaveProperty("ownerId");
    expect(plain).not.toHaveProperty("createdByUserId");
    expect(plain).not.toHaveProperty("role");
    expect(plain).not.toHaveProperty("roles");
    expect(plain).not.toHaveProperty("members");
    expect(plain).not.toHaveProperty("memberships");
  });

  it("excludes __v from normal serialization", async () => {
    const org = await organizationRepository.create({ name: "Version Key", slug: "version-key" });
    expect(org.toJSON()).not.toHaveProperty("__v");
  });

  // ---- widget installation (ADR-020) ----

  describe("ensureWidgetKey", () => {
    it("leaves an existing key untouched", async () => {
      const org = await organizationRepository.create({ name: "Has Key", slug: "has-key" });

      const result = await organizationRepository.ensureWidgetKey(org._id.toString());

      expect(result!.widgetKey).toBe(org.widgetKey);
    });

    it("mints and persists a key for an organization that has none", async () => {
      const org = await OrganizationModel.create({ name: "Legacy", slug: "legacy-ensure" });
      await OrganizationModel.updateOne({ _id: org._id }, { $unset: { widgetKey: "" } });

      const result = await organizationRepository.ensureWidgetKey(org._id.toString());

      expect(isWellFormedWidgetKey(result!.widgetKey!)).toBe(true);
      const persisted = await OrganizationModel.findById(org._id);
      expect(persisted!.widgetKey).toBe(result!.widgetKey);
    });

    it("returns null for an organization that does not exist", async () => {
      const result = await organizationRepository.ensureWidgetKey(new mongoose.Types.ObjectId().toString());
      expect(result).toBeNull();
    });
  });

  describe("replaceAllowedOrigins", () => {
    it("replaces the stored list", async () => {
      const org = await organizationRepository.create({ name: "Origins", slug: "origins-replace" });

      const result = await organizationRepository.replaceAllowedOrigins(org._id.toString(), [
        "https://shop.example.com",
      ]);

      expect(result!.allowedOrigins).toEqual(["https://shop.example.com"]);
    });

    it("runs the model's own setter, so two spellings of one origin cannot both be stored", async () => {
      const org = await organizationRepository.create({ name: "Canon", slug: "origins-canon" });

      const result = await organizationRepository.replaceAllowedOrigins(org._id.toString(), [
        "HTTPS://Shop.Example.COM:443/",
      ]);

      expect(result!.allowedOrigins).toEqual(["https://shop.example.com"]);
    });

    it("rejects an invalid origin through the model's own validator", async () => {
      const org = await organizationRepository.create({ name: "Invalid", slug: "origins-invalid" });

      await expect(
        organizationRepository.replaceAllowedOrigins(org._id.toString(), ["https://*.example.com"]),
      ).rejects.toThrow(/allowedOrigins/);
    });

    it("mints a widget key for an organization that had none", async () => {
      const org = await OrganizationModel.create({ name: "Legacy", slug: "legacy-origins" });
      await OrganizationModel.updateOne({ _id: org._id }, { $unset: { widgetKey: "" } });

      const result = await organizationRepository.replaceAllowedOrigins(org._id.toString(), []);

      expect(isWellFormedWidgetKey(result!.widgetKey!)).toBe(true);
    });

    it("returns null for an organization that does not exist", async () => {
      const result = await organizationRepository.replaceAllowedOrigins(new mongoose.Types.ObjectId().toString(), []);
      expect(result).toBeNull();
    });
  });

  describe("rotateWidgetKey", () => {
    it("replaces the key with a new, well-formed one", async () => {
      const org = await organizationRepository.create({ name: "Rotate", slug: "rotate-key" });

      const result = await organizationRepository.rotateWidgetKey(org._id.toString());

      expect(isWellFormedWidgetKey(result!.widgetKey!)).toBe(true);
      expect(result!.widgetKey).not.toBe(org.widgetKey);
    });

    it("persists the new key so a later lookup finds it and the old one resolves nothing", async () => {
      const org = await organizationRepository.create({ name: "Rotate Persist", slug: "rotate-persist" });
      const oldKey = org.widgetKey!;

      const rotated = await organizationRepository.rotateWidgetKey(org._id.toString());

      expect(await organizationRepository.findByWidgetKey(oldKey)).toBeNull();
      expect((await organizationRepository.findByWidgetKey(rotated!.widgetKey!))!._id.toString()).toBe(
        org._id.toString(),
      );
    });

    it("returns null for an organization that does not exist", async () => {
      const result = await organizationRepository.rotateWidgetKey(new mongoose.Types.ObjectId().toString());
      expect(result).toBeNull();
    });
  });
});
