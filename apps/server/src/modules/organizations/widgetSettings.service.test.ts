import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OrganizationNotAccessibleError } from "../../lib/errors";
import { OrganizationModel } from "./organization.model";
import { organizationRepository } from "./organization.repository";
import { isWellFormedWidgetKey } from "./widgetConfig";
import { createWidgetSettingsService } from "./widgetSettings.service";

import type { AuthLogger } from "../auth/authLogging";

/** Obvious sentinel — if this reaches a captured log entry, the test fails. */
const ACTOR_USER_ID = "USER_ID_SENTINEL";

interface CapturedLog {
  payload: Record<string, unknown>;
  message: string;
}

/** Capture logger, matching `registration.service.test.ts`'s pattern. */
function createCapturingLogger() {
  const entries: CapturedLog[] = [];
  const log: AuthLogger = {
    info(payload, message) {
      entries.push({ payload, message });
    },
    error(payload, message) {
      entries.push({ payload, message });
    },
  };
  return { log, entries, serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n") };
}

async function createOrganization(overrides: { name?: string; slug?: string } = {}) {
  return organizationRepository.create({ name: overrides.name ?? "Acme", slug: overrides.slug ?? "acme" });
}

describe("widget settings service", () => {
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

  describe("getSettings", () => {
    it("returns the existing key and origins", async () => {
      const organization = await createOrganization();
      const service = createWidgetSettingsService();

      const settings = await service.getSettings(organization._id.toString());

      expect(settings.widgetKey).toBe(organization.widgetKey);
      expect(settings.allowedOrigins).toEqual([]);
    });

    it("mints and persists a key for an organization that has none", async () => {
      const organization = await OrganizationModel.create({ name: "Legacy", slug: "legacy" });
      await OrganizationModel.updateOne({ _id: organization._id }, { $unset: { widgetKey: "" } });
      const service = createWidgetSettingsService();

      const settings = await service.getSettings(organization._id.toString());

      expect(isWellFormedWidgetKey(settings.widgetKey)).toBe(true);
      const persisted = await OrganizationModel.findById(organization._id);
      expect(persisted!.widgetKey).toBe(settings.widgetKey);
    });

    it("throws OrganizationNotAccessibleError for an organization that does not exist", async () => {
      const service = createWidgetSettingsService();

      await expect(service.getSettings(new mongoose.Types.ObjectId().toString())).rejects.toThrow(
        OrganizationNotAccessibleError,
      );
    });
  });

  describe("replaceAllowedOrigins", () => {
    it("stores the given origins", async () => {
      const organization = await createOrganization();
      const service = createWidgetSettingsService();

      const settings = await service.replaceAllowedOrigins(
        organization._id.toString(),
        ["https://shop.example.com"],
        { userId: ACTOR_USER_ID },
      );

      expect(settings.allowedOrigins).toEqual(["https://shop.example.com"]);
    });

    it("logs the event, the actor, and a count — never the origins themselves", async () => {
      const organization = await createOrganization();
      const service = createWidgetSettingsService();
      const { log, serialized } = createCapturingLogger();

      await service.replaceAllowedOrigins(
        organization._id.toString(),
        ["https://shop.example.com", "https://admin.example.com"],
        { userId: ACTOR_USER_ID },
        log,
      );

      expect(serialized()).toContain("organization.allowed_origins_updated");
      expect(serialized()).toContain(ACTOR_USER_ID);
      expect(serialized()).toContain("\"originCount\":2");
      expect(serialized()).not.toContain("shop.example.com");
      expect(serialized()).not.toContain("admin.example.com");
    });

    it("throws OrganizationNotAccessibleError for an organization that does not exist", async () => {
      const service = createWidgetSettingsService();

      await expect(
        service.replaceAllowedOrigins(new mongoose.Types.ObjectId().toString(), [], { userId: ACTOR_USER_ID }),
      ).rejects.toThrow(OrganizationNotAccessibleError);
    });
  });

  describe("rotateWidgetKey", () => {
    it("returns a new key, different from the old one", async () => {
      const organization = await createOrganization();
      const service = createWidgetSettingsService();

      const settings = await service.rotateWidgetKey(organization._id.toString(), { userId: ACTOR_USER_ID });

      expect(isWellFormedWidgetKey(settings.widgetKey)).toBe(true);
      expect(settings.widgetKey).not.toBe(organization.widgetKey);
    });

    it("logs the event and the actor, and never the key — old or new", async () => {
      const organization = await createOrganization();
      const oldKey = organization.widgetKey!;
      const service = createWidgetSettingsService();
      const { log, serialized } = createCapturingLogger();

      const settings = await service.rotateWidgetKey(organization._id.toString(), { userId: ACTOR_USER_ID }, log);

      expect(serialized()).toContain("organization.widget_key_rotated");
      expect(serialized()).toContain(ACTOR_USER_ID);
      expect(serialized()).not.toContain(oldKey);
      expect(serialized()).not.toContain(settings.widgetKey);
    });

    it("throws OrganizationNotAccessibleError for an organization that does not exist", async () => {
      const service = createWidgetSettingsService();

      await expect(
        service.rotateWidgetKey(new mongoose.Types.ObjectId().toString(), { userId: ACTOR_USER_ID }),
      ).rejects.toThrow(OrganizationNotAccessibleError);
    });
  });
});
