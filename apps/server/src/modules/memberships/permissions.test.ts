import { describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS, can, permissionsFor } from "./permissions";

import type { MembershipRole } from "./membership.model";
import type { Permission } from "./permissions";

/** The roles the schema enum declares. Restated so a drift fails here. */
const ROLES: MembershipRole[] = ["owner", "admin", "supervisor", "agent"];

const ALL_PERMISSIONS: Permission[] = [
  "organization.read",
  "organization.manage",
  "member.read",
  "member.manage",
];

describe("ROLE_PERMISSIONS", () => {
  it("covers every role the schema allows", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  /*
    ADR-010 §2 gives three independent sufficient reasons, and a customer
    holds no Membership to carry a role in the first place. This is the
    assertion that fails the moment someone adds one.
  */
  it("has no customer role", () => {
    expect(ROLE_PERMISSIONS).not.toHaveProperty("customer");
    expect(Object.keys(ROLE_PERMISSIONS)).not.toContain("customer");
  });

  it("grants only permissions from the catalogue", () => {
    for (const role of ROLES) {
      for (const permission of permissionsFor(role)) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  /*
    Permissions for resources that do not exist are deliberately absent
    (ADR-017 §7) — the same unexercised security surface accessToken.ts
    refused to create when it declined to write a verifier before its first
    caller.
  */
  it.each([["conversation.read"], ["ticket.update"], ["ai.configure"], ["customer.read"]])(
    "does not yet define %j, which has nothing to guard",
    (absent) => {
      for (const role of ROLES) {
        expect(permissionsFor(role) as readonly string[]).not.toContain(absent);
      }
    },
  );

  it("gives every role the ability to see the organization it belongs to", () => {
    for (const role of ROLES) {
      expect(can(role, "organization.read")).toBe(true);
    }
  });

  it("grants no duplicates", () => {
    for (const role of ROLES) {
      const granted = permissionsFor(role);
      expect(new Set(granted).size).toBe(granted.length);
    }
  });
});

describe("can", () => {
  // The full matrix, stated rather than derived, so a change to the table is
  // a change to this test.
  const MATRIX: Record<MembershipRole, Record<Permission, boolean>> = {
    owner: {
      "organization.read": true,
      "organization.manage": true,
      "member.read": true,
      "member.manage": true,
    },
    admin: {
      "organization.read": true,
      "organization.manage": true,
      "member.read": true,
      "member.manage": true,
    },
    supervisor: {
      "organization.read": true,
      "organization.manage": false,
      "member.read": true,
      "member.manage": false,
    },
    agent: {
      "organization.read": true,
      "organization.manage": false,
      "member.read": false,
      "member.manage": false,
    },
  };

  for (const role of ROLES) {
    for (const permission of ALL_PERMISSIONS) {
      const expected = MATRIX[role][permission];
      it(`${expected ? "grants" : "denies"} ${permission} to ${role}`, () => {
        expect(can(role, permission)).toBe(expected);
      });
    }
  }

  it("gives owner and admin the same authority today", () => {
    expect([...permissionsFor("owner")].sort()).toEqual([...permissionsFor("admin")].sort());
  });

  // The gradient the middleware tests rely on: not every role holds every
  // permission, or an insufficient-permission test could never fail.
  it("leaves a real gradient between roles", () => {
    expect(permissionsFor("owner").length).toBeGreaterThan(permissionsFor("supervisor").length);
    expect(permissionsFor("supervisor").length).toBeGreaterThan(permissionsFor("agent").length);
  });
});
