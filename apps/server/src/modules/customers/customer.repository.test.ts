import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CustomerModel } from "./customer.model";
import { customerRepository } from "./customer.repository";

const ORGANIZATION_A = new Types.ObjectId();
const ORGANIZATION_B = new Types.ObjectId();

describe("customerRepository", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await CustomerModel.init();
  });

  afterEach(async () => {
    await CustomerModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe("create", () => {
    it("creates an anonymous customer with neither name nor email", async () => {
      const customer = await customerRepository.create({ organizationId: ORGANIZATION_A });

      expect(customer.organizationId.toString()).toBe(ORGANIZATION_A.toString());
      expect(customer.name).toBeNull();
      expect(customer.email).toBeNull();
    });

    it("creates a customer with the details a visitor supplied", async () => {
      const customer = await customerRepository.create({
        organizationId: ORGANIZATION_A,
        name: "Ada Lovelace",
        email: "ada@example.com",
      });

      expect(customer.name).toBe("Ada Lovelace");
      expect(customer.email).toBe("ada@example.com");
    });

    it("normalizes email the way user.model.ts does", async () => {
      const customer = await customerRepository.create({
        organizationId: ORGANIZATION_A,
        email: "  Ada@Example.COM  ",
      });

      expect(customer.email).toBe("ada@example.com");
    });

    it("trims a name", async () => {
      const customer = await customerRepository.create({
        organizationId: ORGANIZATION_A,
        name: "  Ada Lovelace  ",
      });

      expect(customer.name).toBe("Ada Lovelace");
    });

    it("stamps lastSeenAt on creation", async () => {
      const before = Date.now();
      const customer = await customerRepository.create({ organizationId: ORGANIZATION_A });

      expect(customer.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(customer.lastSeenAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    // A customer who belongs to no organization is not something this system
    // can represent (ADR-010 §4).
    it("refuses a customer with no organization", async () => {
      await expect(
        customerRepository.create({ organizationId: undefined as unknown as Types.ObjectId }),
      ).rejects.toThrow();
    });

    /*
      Two anonymous visitors are genuinely two customers, and there is no
      uniqueness key that would collapse them (ADR-019 §3).
    */
    it("creates two distinct customers for two anonymous visits", async () => {
      const first = await customerRepository.create({ organizationId: ORGANIZATION_A });
      const second = await customerRepository.create({ organizationId: ORGANIZATION_A });

      expect(first._id.toString()).not.toBe(second._id.toString());
    });

    /*
      Email is NOT an identity key. Two people typing one address in one
      tenant are two customers — which is exactly what stops a typed address
      from being a way to inherit someone else's identity (ADR-019 §5).
    */
    it("allows the same email twice inside one organization", async () => {
      await customerRepository.create({ organizationId: ORGANIZATION_A, email: "ada@example.com" });

      await expect(
        customerRepository.create({ organizationId: ORGANIZATION_A, email: "ada@example.com" }),
      ).resolves.toBeDefined();
    });

    /*
      ADR-010 §4: "The same human contacting two tenants is deliberately two
      Customer documents; that is what tenant isolation means for this
      entity." A global unique index would forbid exactly that.
    */
    it("allows the same email in two different organizations", async () => {
      const inA = await customerRepository.create({ organizationId: ORGANIZATION_A, email: "ada@example.com" });
      const inB = await customerRepository.create({ organizationId: ORGANIZATION_B, email: "ada@example.com" });

      expect(inA._id.toString()).not.toBe(inB._id.toString());
      expect(inA.organizationId.toString()).not.toBe(inB.organizationId.toString());
    });
  });

  describe("findByIdAndOrganization", () => {
    it("finds a customer inside its own organization", async () => {
      const created = await customerRepository.create({ organizationId: ORGANIZATION_A });

      const found = await customerRepository.findByIdAndOrganization(created._id, ORGANIZATION_A);

      expect(found?._id.toString()).toBe(created._id.toString());
    });

    /*
      THE tenant isolation test. A correct customer id under the WRONG
      organization must find nothing — proved by the query rather than by a
      comparison the caller writes (ADR-019 §4).
    */
    it("does not find a customer through another organization", async () => {
      const inA = await customerRepository.create({ organizationId: ORGANIZATION_A });

      const throughB = await customerRepository.findByIdAndOrganization(inA._id, ORGANIZATION_B);

      expect(throughB).toBeNull();
    });

    it("returns null for an id that does not exist", async () => {
      const missing = await customerRepository.findByIdAndOrganization(new Types.ObjectId(), ORGANIZATION_A);

      expect(missing).toBeNull();
    });

    it("accepts string ids as well as ObjectIds", async () => {
      const created = await customerRepository.create({ organizationId: ORGANIZATION_A });

      const found = await customerRepository.findByIdAndOrganization(
        created._id.toString(),
        ORGANIZATION_A.toString(),
      );

      expect(found?._id.toString()).toBe(created._id.toString());
    });
  });

  describe("recordVisit", () => {
    it("updates lastSeenAt", async () => {
      const created = await customerRepository.create({ organizationId: ORGANIZATION_A });
      const originalLastSeen = created.lastSeenAt.getTime();

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await customerRepository.recordVisit(created._id, ORGANIZATION_A);

      expect(updated!.lastSeenAt.getTime()).toBeGreaterThan(originalLastSeen);
    });

    it("writes details a returning visitor supplied for the first time", async () => {
      const created = await customerRepository.create({ organizationId: ORGANIZATION_A });

      const updated = await customerRepository.recordVisit(created._id, ORGANIZATION_A, {
        name: "Ada Lovelace",
        email: "ada@example.com",
      });

      expect(updated!.name).toBe("Ada Lovelace");
      expect(updated!.email).toBe("ada@example.com");
    });

    /*
      A widget that forgot to send a field must not erase what the visitor
      typed a minute earlier (ADR-019 §5).
    */
    it("does not clear stored details when none are supplied", async () => {
      const created = await customerRepository.create({
        organizationId: ORGANIZATION_A,
        name: "Ada Lovelace",
        email: "ada@example.com",
      });

      const updated = await customerRepository.recordVisit(created._id, ORGANIZATION_A);

      expect(updated!.name).toBe("Ada Lovelace");
      expect(updated!.email).toBe("ada@example.com");
    });

    it("does not clear stored details when they are supplied as null", async () => {
      const created = await customerRepository.create({
        organizationId: ORGANIZATION_A,
        name: "Ada Lovelace",
      });

      const updated = await customerRepository.recordVisit(created._id, ORGANIZATION_A, {
        name: null,
        email: null,
      });

      expect(updated!.name).toBe("Ada Lovelace");
    });

    /*
      The cross-tenant write guard. A write located by `_id` alone would be a
      cross-tenant write waiting for a caller to pass the wrong organization.
    */
    it("does not update a customer through another organization", async () => {
      const inA = await customerRepository.create({ organizationId: ORGANIZATION_A, name: "Ada" });

      const throughB = await customerRepository.recordVisit(inA._id, ORGANIZATION_B, { name: "Grace" });

      expect(throughB).toBeNull();
      const untouched = await customerRepository.findByIdAndOrganization(inA._id, ORGANIZATION_A);
      expect(untouched!.name).toBe("Ada");
    });

    it("returns null for a customer that does not exist", async () => {
      const result = await customerRepository.recordVisit(new Types.ObjectId(), ORGANIZATION_A);

      expect(result).toBeNull();
    });
  });

  describe("the serialization boundary", () => {
    /*
      There is no credential, hash, or token on this model to strip — that is
      the design (ADR-010 §1). What must not survive is Mongoose's internal
      bookkeeping.
    */
    it("carries no credential-shaped field at all", async () => {
      const customer = await customerRepository.create({
        organizationId: ORGANIZATION_A,
        email: "ada@example.com",
      });

      const serialized = JSON.parse(JSON.stringify(customer));

      for (const forbidden of ["passwordHash", "password", "token", "secret", "sessionId", "role", "__v"]) {
        expect(serialized).not.toHaveProperty(forbidden);
      }
    });

    it("exposes exactly the documented field set", async () => {
      const customer = await customerRepository.create({ organizationId: ORGANIZATION_A });

      const serialized = JSON.parse(JSON.stringify(customer));

      expect(Object.keys(serialized).sort()).toEqual([
        "_id",
        "createdAt",
        "email",
        "lastSeenAt",
        "name",
        "organizationId",
        "updatedAt",
        // Null for every widget visitor; set only for a customer who signed in
        // (ADR-034 §3).
        "userId",
      ]);
    });
  });

  describe("indexes", () => {
    /*
      ADR-019 §3 said "the tenant-boundary index, and deliberately the only
      one". ADR-034 §3 added a second — the account link — and these
      assertions were rewritten to protect what that rule was actually FOR
      rather than its original count.

      The two things that must never happen are unchanged: an index on `email`
      would be the first half of writing the lookup that must not exist, and a
      unique constraint reaching anonymous visitors would collapse two
      genuinely distinct people into one.
    */
    it("indexes the tenant and the account link, and nothing else", async () => {
      const indexes = await CustomerModel.collection.indexes();
      const keys = indexes.map((index) => JSON.stringify(index.key)).sort();

      expect(keys).toEqual(
        [
          JSON.stringify({ _id: 1 }),
          JSON.stringify({ organizationId: 1 }),
          JSON.stringify({ organizationId: 1, userId: 1 }),
        ].sort(),
      );
    });

    /* The lookup that must not exist, asserted directly. */
    it("indexes nothing by email", async () => {
      const indexes = await CustomerModel.collection.indexes();

      for (const index of indexes) {
        expect(Object.keys(index.key)).not.toContain("email");
      }
    });

    it("constrains only the account link, and only where one exists", async () => {
      const indexes = await CustomerModel.collection.indexes();
      const unique = indexes.filter((index) => index.unique === true);

      expect(unique).toHaveLength(1);
      expect(JSON.stringify(unique[0]!.key)).toBe(JSON.stringify({ organizationId: 1, userId: 1 }));
      // Partial, which is what keeps it away from anonymous visitors.
      expect(unique[0]!.partialFilterExpression).toBeDefined();
    });

    /*
      The invariant the old "no unique constraint" assertion was protecting,
      tested as behaviour rather than as schema: two anonymous visitors in one
      tenant are two customers, and the new constraint must not merge them.
    */
    it("still lets one tenant hold many anonymous visitors", async () => {
      const first = await customerRepository.create({ organizationId: ORGANIZATION_A });
      const second = await customerRepository.create({ organizationId: ORGANIZATION_A });

      expect(first._id.toString()).not.toBe(second._id.toString());
    });

    /* And the constraint does its job for accounts that DO exist. */
    it("refuses a second customer for one account in one tenant", async () => {
      const userId = new Types.ObjectId();
      await customerRepository.create({ organizationId: ORGANIZATION_A, userId });

      await expect(customerRepository.create({ organizationId: ORGANIZATION_A, userId })).rejects.toThrow();
    });
  });
});
