import { describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS, can, permissionsFor } from "./permissions";

import type { MembershipRole } from "./membership.model";
import type { Permission } from "./permissions";

/** The roles the schema enum declares. Restated so a drift fails here. */
const ROLES: MembershipRole[] = ["owner", "admin", "supervisor", "agent"];

const ALL_PERMISSIONS: Permission[] = [
  "organization.read",
  "organization.manage",
  // Joined the catalogue in ADR-028, the slice that gave the owner a route to
  // hand the tenant over through. The FIRST permission `admin` does not also
  // hold — see "owner is admin plus exactly one permission" below.
  "organization.transfer_ownership",
  "member.read",
  "member.manage",
  // Joined the catalogue in ADR-025, the slice that gave agents routes and a
  // socket to reach conversations through — which is the rule this file's
  // "has nothing to guard" cases below state from the other side.
  "conversation.read",
  "conversation.reply",
  "conversation.assign",
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

    "conversation.read" was on this list until ADR-025 and has moved to the
    catalogue above, which is precisely the lifecycle permissions.ts
    describes: "a permission joins this union in the slice that enforces
    it." A ticket and an AI configuration surface still do not exist.
  */
  it.each([["ticket.update"], ["ai.configure"], ["customer.read"]])(
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
      // ADR-028 §2. The one row in this matrix that separates owner from
      // admin, and the whole meaning of the word "owner" in Serviqo.
      "organization.transfer_ownership": true,
      "member.read": true,
      "member.manage": true,
      "conversation.read": true,
      "conversation.reply": true,
      "conversation.assign": true,
    },
    admin: {
      "organization.read": true,
      "organization.manage": true,
      /*
        NOT granted, and this is the assertion that stops a future slice from
        widening admin by accident. An admin who could transfer ownership could
        take the tenant from the person who created it — a privilege-escalation
        primitive dressed as an administrative convenience (ADR-028 §2).
      */
      "organization.transfer_ownership": false,
      "member.read": true,
      "member.manage": true,
      "conversation.read": true,
      "conversation.reply": true,
      "conversation.assign": true,
    },
    supervisor: {
      "organization.read": true,
      "organization.manage": false,
      "organization.transfer_ownership": false,
      "member.read": true,
      "member.manage": false,
      // Oversees queues, so reads and answers conversations; still cannot
      // configure the tenant or change its roster (ADR-025 §4).
      "conversation.read": true,
      "conversation.reply": true,
      "conversation.assign": true,
    },
    agent: {
      "organization.read": true,
      "organization.manage": false,
      "organization.transfer_ownership": false,
      "member.read": false,
      "member.manage": false,
      // The role whose whole description is handling conversations, and as
      // of ADR-025 the permissions exist for it to actually do so.
      "conversation.read": true,
      "conversation.reply": true,
      // Claiming is how an agent takes responsibility for the reply they are
      // about to write (ADR-026 §3). Note this role still lacks
      // `member.read`, which is exactly why the inbox withholds a
      // colleague's NAME from it while disclosing the assignee id
      // (ADR-026 §11).
      "conversation.assign": true,
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

  /*
    The successor to "gives owner and admin the same authority today", which
    held from ADR-017 until ADR-028 and is now false by design.

    Stated as an exact set difference rather than as "owner has more": the
    point is that the gap is EXACTLY ONE permission and exactly which one, so
    granting `organization.transfer_ownership` to admin, or quietly widening
    the gap with a second owner-only permission, both fail here (ADR-028 §2).
  */
  it("makes owner exactly admin plus organization.transfer_ownership", () => {
    const ownerOnly = permissionsFor("owner").filter(
      (permission) => !(permissionsFor("admin") as readonly Permission[]).includes(permission),
    );
    const adminOnly = permissionsFor("admin").filter(
      (permission) => !(permissionsFor("owner") as readonly Permission[]).includes(permission),
    );

    expect(ownerOnly).toEqual(["organization.transfer_ownership"]);
    expect(adminOnly).toEqual([]);
  });

  /*
    The property ADR-028 §2 relies on when it argues the refusals in §6 are
    safe to answer specifically: the caller holding this permission can already
    read the roster those refusals describe.
  */
  it("gives every holder of organization.transfer_ownership the roster too", () => {
    for (const role of ROLES) {
      if (can(role, "organization.transfer_ownership")) expect(can(role, "member.read")).toBe(true);
    }
  });

  it("grants organization.transfer_ownership to exactly one role", () => {
    expect(ROLES.filter((role) => can(role, "organization.transfer_ownership"))).toEqual(["owner"]);
  });

  // The gradient the middleware tests rely on: not every role holds every
  // permission, or an insufficient-permission test could never fail.
  it("leaves a real gradient between roles", () => {
    expect(permissionsFor("owner").length).toBeGreaterThan(permissionsFor("supervisor").length);
    expect(permissionsFor("supervisor").length).toBeGreaterThan(permissionsFor("agent").length);
  });
});
