import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { sortMembers, toMemberResponse } from "./member.responses";

import type { MembershipDocument, MembershipRole } from "../memberships/membership.model";
import type { UserDocument } from "../users/user.model";
import type { MemberResponse } from "./member.responses";

/**
 * Unit coverage for the roster projection (ADR-027 §14).
 *
 * The assertion that matters most and is invisible when broken: the projection
 * must NOT carry `passwordHash`, `failedLoginAttempts`, `lockedUntil`, or
 * `emailVerifiedAt`. It is built field by field precisely so a schema addition
 * cannot ride along, and this suite is what would notice if someone replaced
 * it with a spread.
 *
 * Plain objects rather than real documents: `toMemberResponse` reads five
 * fields and calls `.toString()` on one, so a real Mongoose document adds
 * setup and proves nothing extra. The integration suite exercises the real
 * documents through the real route.
 */

function membership(overrides: Partial<{ id: string; role: MembershipRole; status: string; userId: string }> = {}) {
  return {
    _id: new Types.ObjectId(overrides.id ?? "507f1f77bcf86cd799439011"),
    userId: new Types.ObjectId(overrides.userId ?? "507f1f77bcf86cd799439012"),
    role: overrides.role ?? "agent",
    status: overrides.status ?? "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  } as unknown as MembershipDocument;
}

function user(overrides: Partial<{ id: string; name: string; email: string }> = {}) {
  return {
    _id: new Types.ObjectId(overrides.id ?? "507f1f77bcf86cd799439012"),
    name: overrides.name ?? "Ada Lovelace",
    email: overrides.email ?? "ada@example.com",
    // Everything below is what must NOT survive the projection.
    passwordHash: "DO_NOT_LEAK_THIS_HASH",
    failedLoginAttempts: 3,
    lockedUntil: new Date("2030-01-01T00:00:00.000Z"),
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "active",
  } as unknown as UserDocument;
}

function member(role: MembershipRole, name: string | null, id: string): MemberResponse {
  return {
    id,
    role,
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    user: name === null ? null : { id: "507f1f77bcf86cd799439012", name, email: "x@example.com" },
  };
}

describe("toMemberResponse", () => {
  it("projects the membership id, role, status, and the user's identity", () => {
    const projected = toMemberResponse(
      membership({ id: "507f1f77bcf86cd799439011", role: "admin", status: "active" }),
      user({ name: "Ada Lovelace", email: "ada@example.com" }),
    );

    expect(projected).toEqual({
      id: "507f1f77bcf86cd799439011",
      role: "admin",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      user: { id: "507f1f77bcf86cd799439012", name: "Ada Lovelace", email: "ada@example.com" },
    });
  });

  it("carries no authentication state — the fields a spread would have leaked", () => {
    const projected = toMemberResponse(membership(), user());

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("DO_NOT_LEAK_THIS_HASH");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("failedLoginAttempts");
    expect(serialized).not.toContain("lockedUntil");
    expect(serialized).not.toContain("emailVerifiedAt");
  });

  it("carries no organizationId and no invitedByUserId (ADR-027 §14)", () => {
    const projected = toMemberResponse(membership(), user());

    expect(projected).not.toHaveProperty("organizationId");
    expect(projected).not.toHaveProperty("invitedByUserId");
  });

  it("reports a null user for a membership whose account no longer resolves", () => {
    const projected = toMemberResponse(membership(), null);

    expect(projected.user).toBeNull();
    // The row itself is still real and still removable.
    expect(projected.id).toBe("507f1f77bcf86cd799439011");
  });

  it("reports invited and suspended memberships rather than hiding them", () => {
    expect(toMemberResponse(membership({ status: "invited" }), user()).status).toBe("invited");
    expect(toMemberResponse(membership({ status: "suspended" }), user()).status).toBe("suspended");
  });
});

describe("sortMembers", () => {
  it("orders by role rank — owner, admin, supervisor, agent", () => {
    const sorted = sortMembers([
      member("agent", "A", "1"),
      member("owner", "B", "2"),
      member("supervisor", "C", "3"),
      member("admin", "D", "4"),
    ]);

    expect(sorted.map((m) => m.role)).toEqual(["owner", "admin", "supervisor", "agent"]);
  });

  it("orders by name within a role", () => {
    const sorted = sortMembers([member("agent", "Zoe", "1"), member("agent", "Ada", "2")]);

    expect(sorted.map((m) => m.user?.name)).toEqual(["Ada", "Zoe"]);
  });

  it("breaks a shared name by membership id, so the order is stable across calls", () => {
    const rows = [member("agent", "Ada", "b"), member("agent", "Ada", "a")];

    expect(sortMembers(rows).map((m) => m.id)).toEqual(["a", "b"]);
    expect(sortMembers(sortMembers(rows)).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("sorts an unresolved user last within its role rather than throwing", () => {
    const sorted = sortMembers([member("agent", null, "1"), member("agent", "Ada", "2")]);

    expect(sorted.map((m) => m.user?.name ?? null)).toEqual(["Ada", null]);
  });

  it("does not mutate its input", () => {
    const rows = [member("agent", "Zoe", "1"), member("owner", "Ada", "2")];
    sortMembers(rows);

    expect(rows.map((m) => m.role)).toEqual(["agent", "owner"]);
  });
});
