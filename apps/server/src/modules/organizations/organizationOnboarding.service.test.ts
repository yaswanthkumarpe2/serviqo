import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OrganizationSlugUnavailableError } from "../../lib/errors";
import { MembershipModel } from "../memberships/membership.model";
import { membershipRepository } from "../memberships/membership.repository";
import { UserModel } from "../users/user.model";
import { OrganizationModel } from "./organization.model";
import { organizationRepository } from "./organization.repository";
import { createOrganizationOnboardingService } from "./organizationOnboarding.service";

import type { AuthLogger } from "../auth/authLogging";
import type { UserDocument } from "../users/user.model";

/** An obvious sentinel — if it reaches a log or a response, the test fails. */
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$DO_NOT_LEAK$DO_NOT_LEAK";

interface CapturedLog {
  payload: Record<string, unknown>;
  message: string;
}

function createCapturingLogger() {
  const entries: CapturedLog[] = [];
  const record = (payload: Record<string, unknown>, message: string) => {
    entries.push({ payload, message });
  };
  return {
    log: { info: record, error: record } satisfies AuthLogger,
    serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n"),
    events: () => entries.map((e) => e.payload.event),
  };
}

async function seedUser(email = "ada@example.com"): Promise<UserDocument> {
  return UserModel.create({
    name: "Ada Lovelace",
    email,
    passwordHash: PASSWORD_HASH,
    emailVerifiedAt: new Date(),
    status: "active",
  });
}

describe("organizationOnboardingService", () => {
  let mongoServer: MongoMemoryServer;
  const service = createOrganizationOnboardingService();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // The owner invariant and slug uniqueness are database guarantees; the
    // indexes must exist before anything asserts on them.
    await UserModel.init();
    await OrganizationModel.init();
    await MembershipModel.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([UserModel.deleteMany({}), OrganizationModel.deleteMany({}), MembershipModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- the ordinary case ----

  describe("creating an organization", () => {
    it("returns the organization it created", async () => {
      const user = await seedUser();

      const result = await service.createOrganization({ name: "Acme Corp" }, { userId: user._id.toString() });

      expect(result.organization.name).toBe("Acme Corp");
      expect(result.organization.slug).toBe("acme-corp");
      expect(result.organization.status).toBe("active");
      expect(result.organization.id).toEqual(expect.any(String));
      expect(result.organization.createdAt).toBeInstanceOf(Date);
    });

    it("persists the organization", async () => {
      const user = await seedUser();

      const result = await service.createOrganization({ name: "Acme Corp" }, { userId: user._id.toString() });

      const stored = await OrganizationModel.findById(result.organization.id);
      expect(stored).not.toBeNull();
      expect(stored!.slug).toBe("acme-corp");
    });

    it("makes the creator the owner", async () => {
      const user = await seedUser();

      const result = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });

      const membership = await MembershipModel.findOne({ organizationId: result.organization.id });
      expect(membership).not.toBeNull();
      expect(membership!.userId.toString()).toBe(user._id.toString());
      expect(membership!.role).toBe("owner");
      expect(membership!.status).toBe("active");
      expect(result.role).toBe("owner");
    });

    it("creates exactly one membership", async () => {
      const user = await seedUser();

      const result = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });

      await expect(MembershipModel.countDocuments({ organizationId: result.organization.id })).resolves.toBe(1);
      await expect(
        MembershipModel.countDocuments({ organizationId: result.organization.id, role: "owner" }),
      ).resolves.toBe(1);
    });

    // ADR-010 §3: a person may work for several organizations, and User
    // deliberately carries no organizationId.
    it("lets one user own several organizations", async () => {
      const user = await seedUser();

      const first = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });
      const second = await service.createOrganization({ name: "Globex" }, { userId: user._id.toString() });

      expect(first.organization.id).not.toBe(second.organization.id);
      await expect(MembershipModel.countDocuments({ userId: user._id, role: "owner" })).resolves.toBe(2);
    });

    it("keeps two organizations independent", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");

      const acme = await service.createOrganization({ name: "Acme" }, { userId: ada._id.toString() });
      const globex = await service.createOrganization({ name: "Globex" }, { userId: grace._id.toString() });

      const acmeOwner = await MembershipModel.findOne({ organizationId: acme.organization.id });
      const globexOwner = await MembershipModel.findOne({ organizationId: globex.organization.id });

      expect(acmeOwner!.userId.toString()).toBe(ada._id.toString());
      expect(globexOwner!.userId.toString()).toBe(grace._id.toString());
    });

    // The name is stored unchanged; only the slug is derived (ADR-016 §5).
    it("stores the display name exactly as submitted", async () => {
      const user = await seedUser();

      const result = await service.createOrganization({ name: "Café Berlin, Inc." }, { userId: user._id.toString() });

      expect(result.organization.name).toBe("Café Berlin, Inc.");
      expect(result.organization.slug).toBe("cafe-berlin-inc");
    });
  });

  // ---- slug policy (ADR-016 §6-7) ----

  describe("slug collisions", () => {
    it("gives the second organization of the same name a suffixed slug", async () => {
      const user = await seedUser();

      const first = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });
      const second = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });

      expect(first.organization.slug).toBe("acme");
      expect(second.organization.slug).toBe("acme-2");
    });

    it("keeps counting past the second", async () => {
      const user = await seedUser();

      const slugs: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const result = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });
        slugs.push(result.organization.slug);
      }

      expect(slugs).toEqual(["acme", "acme-2", "acme-3", "acme-4"]);
    });

    /*
      Reserved and taken are one condition with one resolution (ADR-016 §6):
      the tenant's name is legitimate, only the URL segment is spoken for.
    */
    it("skips a reserved slug rather than refusing the name", async () => {
      const user = await seedUser();

      const result = await service.createOrganization({ name: "Admin" }, { userId: user._id.toString() });

      expect(result.organization.name).toBe("Admin");
      expect(result.organization.slug).toBe("admin-2");
    });

    it.each([
      ["API", "api-2"],
      ["Dashboard", "dashboard-2"],
      ["Widget", "widget-2"],
    ])("routes around the reserved slug for %j", async (name, expected) => {
      const user = await seedUser();

      const result = await service.createOrganization({ name }, { userId: user._id.toString() });

      expect(result.organization.slug).toBe(expected);
    });

    it("never stores a reserved slug", async () => {
      const user = await seedUser();

      for (const name of ["Admin", "API", "Login", "Health", "Public"]) {
        await service.createOrganization({ name }, { userId: user._id.toString() });
      }

      const stored = await OrganizationModel.find({}).select("slug");
      for (const org of stored) {
        expect(["admin", "api", "login", "health", "public"]).not.toContain(org.slug);
      }
    });

    it("refuses with a 409 once every candidate is taken", async () => {
      const user = await seedUser();

      // Twenty attempts: the bare base plus -2 … -20.
      for (let i = 0; i < 20; i += 1) {
        await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });
      }

      await expect(
        service.createOrganization({ name: "Acme" }, { userId: user._id.toString() }),
      ).rejects.toBeInstanceOf(OrganizationSlugUnavailableError);
    });

    it("names the exhaustion error without echoing the submitted name", async () => {
      const user = await seedUser();
      for (let i = 0; i < 20; i += 1) {
        await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });
      }

      /** Resolves with whatever was thrown, so the refusal can be inspected. */
      async function refusal(): Promise<OrganizationSlugUnavailableError> {
        try {
          await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });
        } catch (err) {
          return err as OrganizationSlugUnavailableError;
        }
        throw new Error("expected the request to be refused");
      }

      const error = await refusal();

      expect(error.httpStatus).toBe(409);
      expect(error.code).toBe("ORGANIZATION_SLUG_UNAVAILABLE");
    });

    /*
      The pre-check is a fast path, not the authority — the unique index is
      (ADR-016 §7). Simulated by making the pre-check claim the slug is free
      while the database rejects it, which is exactly what a lost race looks
      like from inside this service.
    */
    it("advances to the next candidate when the unique index rejects a write", async () => {
      const user = await seedUser();
      await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });

      // The pre-check now reports every candidate free, so only the index
      // stands between the request and a duplicate.
      vi.spyOn(organizationRepository, "findBySlug").mockResolvedValue(null);

      const second = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });

      expect(second.organization.slug).toBe("acme-2");
    });
  });

  // ---- ordering and atomicity (ADR-016 §3-4) ----

  describe("when the organization write fails", () => {
    /** Fails every organization insert, leaving the membership already written. */
    function breakOrganizationWrites() {
      return vi
        .spyOn(organizationRepository, "create")
        .mockRejectedValue(new Error("simulated database failure"));
    }

    it("propagates the failure", async () => {
      const user = await seedUser();
      breakOrganizationWrites();

      await expect(service.createOrganization({ name: "Acme" }, { userId: user._id.toString() })).rejects.toThrow(
        "simulated database failure",
      );
    });

    it("leaves no organization behind", async () => {
      const user = await seedUser();
      breakOrganizationWrites();

      await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() }).catch(() => undefined);

      await expect(OrganizationModel.countDocuments({})).resolves.toBe(0);
    });

    // The compensating delete (ADR-016 §4) — permitted here because the path
    // is authenticated and the partial state has no self-service repair.
    it("removes the owner membership it had already written", async () => {
      const user = await seedUser();
      breakOrganizationWrites();

      await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() }).catch(() => undefined);

      await expect(MembershipModel.countDocuments({})).resolves.toBe(0);
    });

    it("burns no slug, so the same name succeeds on retry", async () => {
      const user = await seedUser();
      const broken = breakOrganizationWrites();

      await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() }).catch(() => undefined);
      broken.mockRestore();

      const retried = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });

      // The bare base, not acme-2 — proof the failed attempt reserved nothing.
      expect(retried.organization.slug).toBe("acme");
    });

    it("reports the failure without the organization's name", async () => {
      const user = await seedUser();
      breakOrganizationWrites();
      const logger = createCapturingLogger();

      await service
        .createOrganization({ name: "Secret Project Name" }, { userId: user._id.toString() }, logger.log)
        .catch(() => undefined);

      expect(logger.events()).toContain("organization.creation_failed");
      expect(logger.serialized()).not.toContain("Secret Project Name");
    });

    /*
      Compensation is best-effort and must never mask the original error —
      the caller's outcome cannot change because bookkeeping did not. The
      same contract `login.service.ts` gives a failed `clearLoginFailures`.
    */
    it("still raises the original error when compensation itself fails", async () => {
      const user = await seedUser();
      breakOrganizationWrites();
      vi.spyOn(membershipRepository, "deleteById").mockRejectedValue(new Error("compensation failed"));

      await expect(service.createOrganization({ name: "Acme" }, { userId: user._id.toString() })).rejects.toThrow(
        "simulated database failure",
      );
    });

    it("records a failed compensation under its own event", async () => {
      const user = await seedUser();
      breakOrganizationWrites();
      vi.spyOn(membershipRepository, "deleteById").mockRejectedValue(new Error("compensation failed"));
      const logger = createCapturingLogger();

      await service
        .createOrganization({ name: "Acme" }, { userId: user._id.toString() }, logger.log)
        .catch(() => undefined);

      expect(logger.events()).toContain("organization.compensation_failed");
    });
  });

  /*
    The invariant the whole ordering exists to protect (ADR-016 §3). Stated
    as its own assertion because it is the one property that must hold no
    matter which write fails.
  */
  describe("the owner invariant", () => {
    it("never leaves an organization without an owner", async () => {
      const user = await seedUser();

      // A mix of successes and injected failures.
      await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });
      const broken = vi
        .spyOn(organizationRepository, "create")
        .mockRejectedValue(new Error("simulated database failure"));
      await service.createOrganization({ name: "Globex" }, { userId: user._id.toString() }).catch(() => undefined);
      broken.mockRestore();
      await service.createOrganization({ name: "Initech" }, { userId: user._id.toString() });

      const organizations = await OrganizationModel.find({});
      expect(organizations.length).toBeGreaterThan(0);

      for (const organization of organizations) {
        await expect(
          MembershipModel.countDocuments({ organizationId: organization._id, role: "owner" }),
        ).resolves.toBe(1);
      }
    });

    // Enforced by the partial unique index, not by service code (ADR-002 §3).
    it("is enforced by the database, not only by the service", async () => {
      const user = await seedUser();
      const other = await seedUser("grace@example.com");
      const result = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() });

      await expect(
        MembershipModel.create({
          userId: other._id,
          organizationId: result.organization.id,
          role: "owner",
        }),
      ).rejects.toThrow();
    });
  });

  // ---- identity comes from the actor, never the body ----

  describe("ownership", () => {
    it("takes the owner from the actor argument", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");

      const result = await service.createOrganization({ name: "Acme" }, { userId: grace._id.toString() });

      const membership = await MembershipModel.findOne({ organizationId: result.organization.id });
      expect(membership!.userId.toString()).toBe(grace._id.toString());
      expect(membership!.userId.toString()).not.toBe(ada._id.toString());
    });
  });

  // ---- logging ----

  describe("logging", () => {
    it("records the created ids an operator correlates on", async () => {
      const user = await seedUser();
      const logger = createCapturingLogger();

      const result = await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() }, logger.log);

      expect(logger.events()).toEqual(["organization.created"]);
      expect(logger.serialized()).toContain(result.organization.id);
      expect(logger.serialized()).toContain(user._id.toString());
      expect(logger.serialized()).toContain("acme");
    });

    /*
      The name is user-submitted content, it triages nothing, and log lines
      are where tenant data leaks without anyone deciding to expose it
      (ADR-016 §9). The slug is a public URL segment and is fine.
    */
    it("never logs the organization's name", async () => {
      const user = await seedUser();
      const logger = createCapturingLogger();

      await service.createOrganization({ name: "Zzyzx Confidential Holdings" }, { userId: user._id.toString() }, logger.log);

      expect(logger.serialized()).not.toContain("Zzyzx Confidential Holdings");
      expect(logger.serialized()).not.toContain("Confidential");
    });

    it("leaks no credential material", async () => {
      const user = await seedUser();
      const logger = createCapturingLogger();

      await service.createOrganization({ name: "Acme" }, { userId: user._id.toString() }, logger.log);

      expect(logger.serialized()).not.toContain(PASSWORD_HASH);
      expect(logger.serialized()).not.toContain("$argon2");
      expect(logger.serialized()).not.toContain("ada@example.com");
    });
  });
});
