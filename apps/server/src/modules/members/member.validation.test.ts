import { describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS, can } from "../memberships/permissions";
import {
  ASSIGNABLE_ROLES,
  SETTABLE_STATUSES,
  addMemberSchema,
  updateMemberRoleSchema,
  updateMemberStatusSchema,
} from "./member.validation";

import type { MembershipRole } from "../memberships/membership.model";

/**
 * Unit coverage for the member request schemas (ADR-027 §4, §6).
 *
 * Two properties here are structural rather than incidental and would be
 * invisible if they broke:
 *
 * 1. The schemas STRIP identity fields rather than rejecting them, so a forged
 *    `userId`/`organizationId`/`status` never becomes observable to a
 *    controller at all (ADR-022 §5's rule applied to identity).
 * 2. `ASSIGNABLE_ROLES` is derived from `ROLE_PERMISSIONS` itself, so there is
 *    exactly one list of role names in the codebase — and `owner` is not in it.
 */

describe("ASSIGNABLE_ROLES", () => {
  it("is derived from the authorization catalogue, minus owner", () => {
    const catalogue = Object.keys(ROLE_PERMISSIONS) as MembershipRole[];

    expect([...ASSIGNABLE_ROLES].sort()).toEqual(catalogue.filter((role) => role !== "owner").sort());
  });

  it("excludes owner — granting ownership is transfer, not a role write (ADR-027 §7a)", () => {
    expect(ASSIGNABLE_ROLES).not.toContain("owner");
  });

  it("names only roles the catalogue actually grants permissions to", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });

  /*
    ADR-027 §10's premise, asserted rather than assumed: every assignable role
    holds `conversation.assign` TODAY, which is why a role change releases
    nothing today. If a future catalogue edit breaks this, the release branch
    starts doing work and this line is what says so.
  */
  it("documents the current catalogue's state: every assignable role holds conversation.assign", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(can(role, "conversation.assign")).toBe(true);
    }
  });
});

describe("addMemberSchema", () => {
  it("accepts an email and an assignable role", () => {
    const parsed = addMemberSchema.safeParse({ email: "ada@example.com", role: "agent" });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ email: "ada@example.com", role: "agent" });
  });

  it("STRIPS a forged identity rather than rejecting it — it never reaches a handler", () => {
    const parsed = addMemberSchema.safeParse({
      email: "ada@example.com",
      role: "agent",
      userId: "507f1f77bcf86cd799439011",
      organizationId: "507f1f77bcf86cd799439012",
      membershipId: "507f1f77bcf86cd799439013",
      invitedByUserId: "507f1f77bcf86cd799439014",
      status: "suspended",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ email: "ada@example.com", role: "agent" });
    expect(parsed.data).not.toHaveProperty("userId");
    expect(parsed.data).not.toHaveProperty("organizationId");
    expect(parsed.data).not.toHaveProperty("status");
    expect(parsed.data).not.toHaveProperty("invitedByUserId");
  });

  it("refuses role: owner", () => {
    expect(addMemberSchema.safeParse({ email: "ada@example.com", role: "owner" }).success).toBe(false);
  });

  it("refuses a role outside the catalogue", () => {
    expect(addMemberSchema.safeParse({ email: "ada@example.com", role: "superuser" }).success).toBe(false);
    expect(addMemberSchema.safeParse({ email: "ada@example.com", role: "customer" }).success).toBe(false);
  });

  it("refuses a missing or malformed email", () => {
    expect(addMemberSchema.safeParse({ role: "agent" }).success).toBe(false);
    expect(addMemberSchema.safeParse({ email: "not-an-email", role: "agent" }).success).toBe(false);
    expect(addMemberSchema.safeParse({ email: "", role: "agent" }).success).toBe(false);
  });

  it("trims surrounding whitespace on the email", () => {
    const parsed = addMemberSchema.safeParse({ email: "  ada@example.com  ", role: "agent" });

    expect(parsed.data?.email).toBe("ada@example.com");
  });

  it("bounds the email length", () => {
    const tooLong = `${"a".repeat(250)}@example.com`;

    expect(addMemberSchema.safeParse({ email: tooLong, role: "agent" }).success).toBe(false);
  });

  it("refuses a non-object body", () => {
    expect(addMemberSchema.safeParse("ada@example.com").success).toBe(false);
    expect(addMemberSchema.safeParse(null).success).toBe(false);
  });
});

describe("updateMemberRoleSchema", () => {
  it("accepts an assignable role and nothing else", () => {
    const parsed = updateMemberRoleSchema.safeParse({
      role: "supervisor",
      membershipId: "507f1f77bcf86cd799439011",
      userId: "507f1f77bcf86cd799439012",
      organizationId: "507f1f77bcf86cd799439013",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ role: "supervisor" });
  });

  it("refuses role: owner — a promotion would collide with the one-owner index (ADR-027 §7a)", () => {
    expect(updateMemberRoleSchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("refuses a missing role", () => {
    expect(updateMemberRoleSchema.safeParse({}).success).toBe(false);
  });
});

/**
 * The status schema (ADR-029 §3, §4).
 *
 * The two assertions that matter most and are invisible when broken:
 *
 * - `invited` is refused, so a manager cannot manufacture a pending
 *   invitation that nobody sent and nobody can accept (ADR-027 §3).
 * - Every identity field sent alongside `status` is STRIPPED, so the route
 *   cannot be aimed at another membership, another tenant, or another role by
 *   a body — which is why no handler downstream contains a comparison
 *   defending against one.
 */
describe("updateMemberStatusSchema", () => {
  it.each([["active"], ["suspended"]])("accepts %s", (status) => {
    const parsed = updateMemberStatusSchema.safeParse({ status });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ status });
  });

  /*
    THE decision of §3. `invited` is a real `MembershipStatus` and is
    deliberately not settable: accepting an invitation is the invitee's action.
  */
  it("refuses invited — an invitation is accepted, not assigned", () => {
    expect(updateMemberStatusSchema.safeParse({ status: "invited" }).success).toBe(false);
    expect(SETTABLE_STATUSES).not.toContain("invited");
  });

  it("names exactly the two statuses a request may set", () => {
    expect([...SETTABLE_STATUSES]).toEqual(["active", "suspended"]);
  });

  it.each([["removed"], ["deleted"], ["Active"], ["ACTIVE"], [""], ["owner"]])(
    "refuses %j",
    (status) => {
      expect(updateMemberStatusSchema.safeParse({ status }).success).toBe(false);
    },
  );

  it.each([[1], [null], [{}], [["active"]], [true]])("refuses a non-string value (%j)", (status) => {
    expect(updateMemberStatusSchema.safeParse({ status }).success).toBe(false);
  });

  it("refuses a missing status", () => {
    expect(updateMemberStatusSchema.safeParse({}).success).toBe(false);
  });

  // ---- ADR-029 §4: identity fields are stripped, not rejected ----

  it("strips a forged membershipId, organizationId, userId, and role", () => {
    const parsed = updateMemberStatusSchema.safeParse({
      status: "suspended",
      membershipId: "507f1f77bcf86cd799439011",
      organizationId: "507f1f77bcf86cd799439012",
      userId: "507f1f77bcf86cd799439013",
      role: "owner",
      invitedByUserId: "507f1f77bcf86cd799439014",
    });

    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data!)).toEqual(["status"]);
  });

  /*
    There is deliberately no way to state the CURRENT status either: "only an
    active membership may be suspended" is checked against the document the
    server loaded, never against a client's claim about it (ADR-029 §4).
  */
  it("strips a claimed current status", () => {
    const parsed = updateMemberStatusSchema.safeParse({ status: "active", currentStatus: "suspended" });

    expect(parsed.data).toEqual({ status: "active" });
  });
});
