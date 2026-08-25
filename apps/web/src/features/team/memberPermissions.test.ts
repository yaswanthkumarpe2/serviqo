import { describe, expect, it } from "vitest";

import { canManageMembers } from "./memberPermissions";

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
