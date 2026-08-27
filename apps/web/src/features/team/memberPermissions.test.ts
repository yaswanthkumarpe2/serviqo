import { describe, expect, it } from "vitest";

import { canManageMembers, canTransferOwnership } from "./memberPermissions";

/**
 * The dashboard's single permission predicate (ADR-027 §16).
 *
 * Small enough to be obvious and worth a suite anyway, because it is the ONE
 * place the client compares a role to anything. Every future permission-aware
 * surface reuses it rather than re-deriving the comparison in JSX, and a test
 * here is what makes a drifted copy visible.
 */
describe("canManageMembers", () => {
  it("allows the roles the server's catalogue grants member.manage", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(true);
  });

  it("refuses a supervisor — member.read is not member.manage", () => {
    expect(canManageMembers("supervisor")).toBe(false);
  });

  it("refuses an agent, who holds neither member permission", () => {
    expect(canManageMembers("agent")).toBe(false);
  });

  it("refuses an unconfirmed role rather than showing a control that may vanish", () => {
    expect(canManageMembers(null)).toBe(false);
    expect(canManageMembers(undefined)).toBe(false);
    expect(canManageMembers("")).toBe(false);
  });

  it("refuses a role string the server would not recognize", () => {
    expect(canManageMembers("superuser")).toBe(false);
    expect(canManageMembers("Owner")).toBe(false);
    expect(canManageMembers("customer")).toBe(false);
  });
});

/**
 * The second predicate, and the first that is narrower than `member.manage`
 * (ADR-028 §2, §16).
 *
 * The `admin` case is the one that matters: an admin holds every management
 * permission and must NOT hold this one, because an admin who could transfer
 * ownership could take the tenant from the person who created it. It is the
 * first place in this UI where `owner` and `admin` diverge, and this suite is
 * what keeps them diverged.
 */
describe("canTransferOwnership", () => {
  it("allows the owner, the only role the server's catalogue grants it", () => {
    expect(canTransferOwnership("owner")).toBe(true);
  });

  it("refuses an admin, who holds every other management permission", () => {
    expect(canTransferOwnership("admin")).toBe(false);
    // Stated together, because the pair is the point: same management rights,
    // different ownership rights.
    expect(canManageMembers("admin")).toBe(true);
  });

  it.each([["supervisor"], ["agent"], ["customer"]])("refuses %s", (role) => {
    expect(canTransferOwnership(role)).toBe(false);
  });

  it("refuses an unconfirmed role rather than showing a destructive control that may vanish", () => {
    expect(canTransferOwnership(null)).toBe(false);
    expect(canTransferOwnership(undefined)).toBe(false);
    expect(canTransferOwnership("")).toBe(false);
  });

  it("refuses a role string the server would not recognize", () => {
    expect(canTransferOwnership("Owner")).toBe(false);
    expect(canTransferOwnership("superuser")).toBe(false);
    expect(canTransferOwnership("owner ")).toBe(false);
  });

  /*
    The relationship the two predicates DO have, asserted so it cannot silently
    invert: everyone who may transfer ownership may also manage members, and
    not the other way round.
  */
  it("is strictly narrower than canManageMembers", () => {
    for (const role of ["owner", "admin", "supervisor", "agent", null]) {
      if (canTransferOwnership(role)) expect(canManageMembers(role)).toBe(true);
    }
    expect(canManageMembers("admin") && !canTransferOwnership("admin")).toBe(true);
  });
});
