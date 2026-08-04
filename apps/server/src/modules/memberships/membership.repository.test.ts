import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OrganizationModel } from "../organizations/organization.model";
import { UserModel } from "../users/user.model";
import { MembershipModel } from "./membership.model";
import { membershipRepository } from "./membership.repository";

/**
 * Uses real User/Organization documents rather than bare ObjectIds so the
 * relationship under test is the one the application will actually store.
 * Referential integrity itself is not enforced by the schema (see
 * membership.model.ts) — that's the service layer's job — so these
 * fixtures exist for realism, not because persistence validates them.
 */
async function createUser(email: string) {
  return UserModel.create({ email, passwordHash: "hashed-value", name: "Test User" });
}

async function createOrganization(slug: string) {
  return OrganizationModel.create({ name: "Test Org", slug });
}

describe("Membership persistence", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // Index creation is async; the uniqueness/owner-invariant tests below
    // assert real database behavior, so the indexes must exist first.
    await MembershipModel.init();
    await UserModel.init();
    await OrganizationModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      MembershipModel.deleteMany({}),
      UserModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- basic creation ----

  it("creates a valid membership", async () => {
    const user = await createUser("member@example.com");
    const org = await createOrganization("acme");

    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "agent",
    });

    expect(membership._id).toBeDefined();
    expect(membership.userId.toString()).toBe(user._id.toString());
    expect(membership.organizationId.toString()).toBe(org._id.toString());
    expect(membership.role).toBe("agent");
  });

  it("requires userId", async () => {
    const org = await createOrganization("no-user");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      membershipRepository.create({ organizationId: org._id, role: "agent" }),
    ).rejects.toThrow(/userId/);
  });

  it("requires organizationId", async () => {
    const user = await createUser("no-org@example.com");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      membershipRepository.create({ userId: user._id, role: "agent" }),
    ).rejects.toThrow(/organizationId/);
  });

  it("requires role", async () => {
    const user = await createUser("no-role@example.com");
    const org = await createOrganization("no-role");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      membershipRepository.create({ userId: user._id, organizationId: org._id }),
    ).rejects.toThrow(/role/);
  });

  it("defaults status to active", async () => {
    const user = await createUser("status@example.com");
    const org = await createOrganization("status-org");

    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "agent",
    });

    expect(membership.status).toBe("active");
  });

  it("rejects an invalid role", async () => {
    const user = await createUser("badrole@example.com");
    const org = await createOrganization("bad-role");

    await expect(
      membershipRepository.create({
        userId: user._id,
        organizationId: org._id,
        // @ts-expect-error -- intentionally invalid enum value to prove validation rejects it.
        role: "customer",
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid status", async () => {
    const user = await createUser("badstatus@example.com");
    const org = await createOrganization("bad-status");

    await expect(
      membershipRepository.create({
        userId: user._id,
        organizationId: org._id,
        role: "agent",
        // @ts-expect-error -- intentionally invalid enum value to prove validation rejects it.
        status: "deleted",
      }),
    ).rejects.toThrow();
  });

  it("sets createdAt and updatedAt on create", async () => {
    const user = await createUser("timestamps@example.com");
    const org = await createOrganization("timestamps-org");

    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "agent",
    });

    expect(membership.createdAt).toBeInstanceOf(Date);
    expect(membership.updatedAt).toBeInstanceOf(Date);
  });

  // ---- relationship uniqueness ----

  it("allows the same user to belong to different organizations", async () => {
    const user = await createUser("multi@example.com");
    const orgA = await createOrganization("org-a");
    const orgB = await createOrganization("org-b");

    await membershipRepository.create({ userId: user._id, organizationId: orgA._id, role: "agent" });
    const second = await membershipRepository.create({
      userId: user._id,
      organizationId: orgB._id,
      role: "admin",
    });

    expect(second._id).toBeDefined();
  });

  it("allows different users to belong to the same organization", async () => {
    const userA = await createUser("a@example.com");
    const userB = await createUser("b@example.com");
    const org = await createOrganization("shared-org");

    await membershipRepository.create({ userId: userA._id, organizationId: org._id, role: "agent" });
    const second = await membershipRepository.create({
      userId: userB._id,
      organizationId: org._id,
      role: "agent",
    });

    expect(second._id).toBeDefined();
  });

  it("rejects a duplicate user+organization membership at the database level", async () => {
    const user = await createUser("dup@example.com");
    const org = await createOrganization("dup-org");

    await membershipRepository.create({ userId: user._id, organizationId: org._id, role: "agent" });

    await expect(
      // A different role must still be rejected — the relationship, not the
      // role, is what must be unique.
      membershipRepository.create({ userId: user._id, organizationId: org._id, role: "admin" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  // ---- owner invariant ----

  it("allows an organization to have one owner", async () => {
    const user = await createUser("owner@example.com");
    const org = await createOrganization("owned-org");

    const owner = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "owner",
    });

    expect(owner.role).toBe("owner");
  });

  it("allows the same user to own different organizations", async () => {
    const user = await createUser("serialowner@example.com");
    const orgA = await createOrganization("owned-a");
    const orgB = await createOrganization("owned-b");

    await membershipRepository.create({ userId: user._id, organizationId: orgA._id, role: "owner" });
    const second = await membershipRepository.create({
      userId: user._id,
      organizationId: orgB._id,
      role: "owner",
    });

    expect(second.role).toBe("owner");
  });

  it("rejects a second owner for the same organization at the database level", async () => {
    const userA = await createUser("owner-a@example.com");
    const userB = await createUser("owner-b@example.com");
    const org = await createOrganization("one-owner");

    await membershipRepository.create({ userId: userA._id, organizationId: org._id, role: "owner" });

    await expect(
      membershipRepository.create({ userId: userB._id, organizationId: org._id, role: "owner" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("does not restrict multiple non-owner members in the same organization", async () => {
    const org = await createOrganization("many-members");
    const owner = await createUser("theowner@example.com");
    const agentA = await createUser("agent-a@example.com");
    const agentB = await createUser("agent-b@example.com");
    const adminA = await createUser("admin-a@example.com");
    const adminB = await createUser("admin-b@example.com");
    const supervisor = await createUser("supervisor@example.com");

    await membershipRepository.create({ userId: owner._id, organizationId: org._id, role: "owner" });
    await membershipRepository.create({ userId: agentA._id, organizationId: org._id, role: "agent" });
    await membershipRepository.create({ userId: agentB._id, organizationId: org._id, role: "agent" });
    await membershipRepository.create({ userId: adminA._id, organizationId: org._id, role: "admin" });
    await membershipRepository.create({ userId: adminB._id, organizationId: org._id, role: "admin" });
    await membershipRepository.create({
      userId: supervisor._id,
      organizationId: org._id,
      role: "supervisor",
    });

    const members = await membershipRepository.findByOrganization(org._id);
    expect(members).toHaveLength(6);
  });

  // ---- concurrency: the database, not a pre-check, is the authority ----

  it("prevents duplicate memberships under concurrent writes", async () => {
    const user = await createUser("race@example.com");
    const org = await createOrganization("race-org");

    const results = await Promise.allSettled([
      membershipRepository.create({ userId: user._id, organizationId: org._id, role: "agent" }),
      membershipRepository.create({ userId: user._id, organizationId: org._id, role: "admin" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(MembershipModel.countDocuments({ organizationId: org._id })).resolves.toBe(1);
  });

  it("prevents two owners under concurrent writes", async () => {
    const userA = await createUser("race-owner-a@example.com");
    const userB = await createUser("race-owner-b@example.com");
    const org = await createOrganization("race-owner-org");

    const results = await Promise.allSettled([
      membershipRepository.create({ userId: userA._id, organizationId: org._id, role: "owner" }),
      membershipRepository.create({ userId: userB._id, organizationId: org._id, role: "owner" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(
      MembershipModel.countDocuments({ organizationId: org._id, role: "owner" }),
    ).resolves.toBe(1);
  });

  // ---- repository ----

  it("finds a membership by id", async () => {
    const user = await createUser("byid@example.com");
    const org = await createOrganization("byid-org");
    const created = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "supervisor",
    });

    const found = await membershipRepository.findById(created._id.toString());
    expect(found?.role).toBe("supervisor");
  });

  it("finds the exact relationship by user and organization", async () => {
    const user = await createUser("exact@example.com");
    const org = await createOrganization("exact-org");
    const created = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "admin",
    });

    const found = await membershipRepository.findByUserAndOrganization(user._id, org._id);
    expect(found?._id.toString()).toBe(created._id.toString());
    expect(found?.role).toBe("admin");
  });

  it("returns null when the user is not a member of the requested organization", async () => {
    const user = await createUser("wrongorg@example.com");
    const memberOf = await createOrganization("member-of");
    const notMemberOf = await createOrganization("not-member-of");

    await membershipRepository.create({ userId: user._id, organizationId: memberOf._id, role: "admin" });

    // The critical tenant-isolation case: a real user, a real organization,
    // and a real membership elsewhere must NOT grant access here.
    const found = await membershipRepository.findByUserAndOrganization(user._id, notMemberOf._id);
    expect(found).toBeNull();
  });

  it("returns null for a user with no membership at all", async () => {
    const stranger = await createUser("stranger@example.com");
    const org = await createOrganization("closed-org");

    const found = await membershipRepository.findByUserAndOrganization(stranger._id, org._id);
    expect(found).toBeNull();
  });

  it("returns only memberships belonging to the requested organization", async () => {
    const userA = await createUser("iso-a@example.com");
    const userB = await createUser("iso-b@example.com");
    const userC = await createUser("iso-c@example.com");
    const orgA = await createOrganization("iso-org-a");
    const orgB = await createOrganization("iso-org-b");

    await membershipRepository.create({ userId: userA._id, organizationId: orgA._id, role: "owner" });
    await membershipRepository.create({ userId: userB._id, organizationId: orgA._id, role: "agent" });
    await membershipRepository.create({ userId: userC._id, organizationId: orgB._id, role: "owner" });

    const orgAMembers = await membershipRepository.findByOrganization(orgA._id);
    const orgBMembers = await membershipRepository.findByOrganization(orgB._id);

    expect(orgAMembers).toHaveLength(2);
    expect(orgBMembers).toHaveLength(1);

    // No Org B membership may ever surface in an Org A query.
    for (const membership of orgAMembers) {
      expect(membership.organizationId.toString()).toBe(orgA._id.toString());
    }
    expect(orgAMembers.map((m) => m.userId.toString())).not.toContain(userC._id.toString());
  });

  // ---- invitation field ----

  it("leaves invitedByUserId null when not supplied", async () => {
    const user = await createUser("noinvite@example.com");
    const org = await createOrganization("noinvite-org");

    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "owner",
    });

    expect(membership.invitedByUserId).toBeNull();
  });

  it("stores invitedByUserId when supplied", async () => {
    const inviter = await createUser("inviter@example.com");
    const invitee = await createUser("invitee@example.com");
    const org = await createOrganization("invite-org");

    const membership = await membershipRepository.create({
      userId: invitee._id,
      organizationId: org._id,
      role: "agent",
      status: "invited",
      invitedByUserId: inviter._id,
    });

    expect(membership.invitedByUserId).toBeInstanceOf(Types.ObjectId);
    expect(membership.invitedByUserId?.toString()).toBe(inviter._id.toString());
    expect(membership.status).toBe("invited");
  });

  // ---- architecture invariants ----

  it("stores role on Membership, and neither User nor Organization duplicates the relationship", async () => {
    const user = await createUser("arch@example.com");
    const org = await createOrganization("arch-org");
    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "owner",
    });

    expect(membership.toObject()).toHaveProperty("role");

    const plainUser = user.toObject();
    expect(plainUser).not.toHaveProperty("role");
    expect(plainUser).not.toHaveProperty("roles");
    expect(plainUser).not.toHaveProperty("permissions");
    expect(plainUser).not.toHaveProperty("organizationId");
    expect(plainUser).not.toHaveProperty("organizationIds");

    const plainOrg = org.toObject();
    expect(plainOrg).not.toHaveProperty("ownerUserId");
    expect(plainOrg).not.toHaveProperty("ownerId");
    expect(plainOrg).not.toHaveProperty("members");
    expect(plainOrg).not.toHaveProperty("memberships");
    expect(plainOrg).not.toHaveProperty("userIds");
  });

  it("does not persist a permissions array on Membership", async () => {
    const user = await createUser("noperms@example.com");
    const org = await createOrganization("noperms-org");
    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "admin",
    });

    expect(membership.toObject()).not.toHaveProperty("permissions");
  });

  it("does not denormalize user identity into Membership", async () => {
    const user = await createUser("nodenorm@example.com");
    const org = await createOrganization("nodenorm-org");
    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "agent",
    });

    const plain = membership.toObject();
    expect(plain).not.toHaveProperty("email");
    expect(plain).not.toHaveProperty("name");
    expect(plain).not.toHaveProperty("passwordHash");
  });

  it("excludes __v from normal serialization", async () => {
    const user = await createUser("version@example.com");
    const org = await createOrganization("version-org");
    const membership = await membershipRepository.create({
      userId: user._id,
      organizationId: org._id,
      role: "agent",
    });

    expect(membership.toJSON()).not.toHaveProperty("__v");
  });
});
