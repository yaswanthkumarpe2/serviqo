import { describe, expect, it, vi } from "vitest";

import { InsufficientPermissionError } from "../lib/errors";
import { requirePermission } from "./requirePermission";

import type { MembershipRole } from "../modules/memberships/membership.model";
import type { Permission } from "../modules/memberships/permissions";
import type { NextFunction, Request, Response } from "express";

const USER_ID = "507f1f77bcf86cd799439011";
const ORGANIZATION_ID = "507f191e810c19729de860ea";
const MEMBERSHIP_ID = "507f191e810c19729de860eb";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A request as `requireOrganization` would have left it. Everything else is
 * deliberately absent, so a change that started reading the body or params
 * would fail here.
 */
function fakeRequest(role: MembershipRole | undefined) {
  const log = fakeLog();
  const req = {
    log,
    principal: { userId: USER_ID, sessionId: "507f191e810c19729de860ec" },
    organizationContext:
      role === undefined ? undefined : { organizationId: ORGANIZATION_ID, role, membershipId: MEMBERSHIP_ID },
  } as unknown as Request;

  return { req, log };
}

function run(role: MembershipRole | undefined, permission: Permission) {
  const { req, log } = fakeRequest(role);
  const next = vi.fn() as unknown as NextFunction;

  requirePermission(permission)(req, {} as Response, next);

  return { req, log, next: next as unknown as ReturnType<typeof vi.fn> };
}

const errorFrom = (next: ReturnType<typeof vi.fn>): unknown => next.mock.calls[0]?.[0];

describe("requirePermission", () => {
  describe("a role that holds the permission", () => {
    it.each<[MembershipRole]>([["owner"], ["admin"], ["supervisor"], ["agent"]])(
      "lets %s through for organization.read",
      (role) => {
        const { next } = run(role, "organization.read");

        expect(next).toHaveBeenCalledOnce();
        expect(next).toHaveBeenCalledWith();
      },
    );

    it.each<[MembershipRole]>([["owner"], ["admin"]])("lets %s through for organization.manage", (role) => {
      const { next } = run(role, "organization.manage");

      expect(next).toHaveBeenCalledWith();
    });

    it.each<[MembershipRole]>([["owner"], ["admin"], ["supervisor"]])(
      "lets %s through for member.read",
      (role) => {
        const { next } = run(role, "member.read");

        expect(next).toHaveBeenCalledWith();
      },
    );

    it("logs nothing when it allows a request", () => {
      const { log } = run("owner", "organization.read");

      expect(log.info).not.toHaveBeenCalled();
    });
  });

  describe("a role that does not hold the permission", () => {
    const REFUSALS: [MembershipRole, Permission][] = [
      ["supervisor", "organization.manage"],
      ["supervisor", "member.manage"],
      ["agent", "organization.manage"],
      ["agent", "member.read"],
      ["agent", "member.manage"],
    ];

    it.each(REFUSALS)("refuses %s for %s", (role, permission) => {
      const { next } = run(role, permission);

      expect(errorFrom(next)).toBeInstanceOf(InsufficientPermissionError);
    });

    it("answers 403 with the approved code", () => {
      const { next } = run("agent", "member.manage");
      const error = errorFrom(next) as InsufficientPermissionError;

      expect(error.httpStatus).toBe(403);
      expect(error.code).toBe("INSUFFICIENT_PERMISSION");
    });

    /*
      403 rather than 404 is safe here and deliberate (ADR-017 §6):
      requireOrganization has already proved membership, so the caller
      demonstrably knows the organization exists and works there.
    */
    it("gives every refusal the same message, so no role is inferable from it", () => {
      const messages = REFUSALS.map(([role, permission]) => {
        const { next } = run(role, permission);
        return (errorFrom(next) as Error).message;
      });

      expect(new Set(messages).size).toBe(1);
    });

    // A fact about Serviqo's authorization model, not about this caller. A
    // client that branched on it would be a client authorizing itself.
    it("does not name the required permission in the error", () => {
      const { next } = run("agent", "member.manage");

      expect((errorFrom(next) as Error).message).not.toContain("member.manage");
    });

    it("records the refusal for an operator, with the role and permission", () => {
      const { log } = run("agent", "member.manage");

      expect(log.info).toHaveBeenCalledOnce();
      const [payload] = log.info.mock.calls[0] as [Record<string, unknown>];
      expect(payload.event).toBe("auth.permission.denied");
      expect(payload.role).toBe("agent");
      expect(payload.permission).toBe("member.manage");
      expect(payload.organizationId).toBe(ORGANIZATION_ID);
      expect(payload.userId).toBe(USER_ID);
    });

    it("does not continue to the handler", () => {
      const { next } = run("agent", "member.manage");

      expect(next).toHaveBeenCalledOnce();
      expect(errorFrom(next)).toBeInstanceOf(InsufficientPermissionError);
    });
  });

  /*
    Mounting this without requireOrganization would check a permission against
    no tenant at all. Failing loudly is the only safe response — a silent pass
    would be an unauthorized write.
  */
  describe("mounted without requireOrganization", () => {
    it("raises rather than allowing the request", () => {
      const { next } = run(undefined, "organization.read");

      const error = errorFrom(next);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InsufficientPermissionError);
      expect((error as Error).message).toContain("requireOrganization");
    });

    it("does not call next() bare", () => {
      const { next } = run(undefined, "organization.read");

      expect(next).toHaveBeenCalledOnce();
      expect(errorFrom(next)).toBeDefined();
    });
  });

  // The role is whatever requireOrganization read from the database. This
  // asserts the middleware consults that and nothing else.
  it("reads the role from the request context only", () => {
    const { req } = fakeRequest("agent");
    // A forged role somewhere a careless implementation might look.
    (req as unknown as { body: unknown }).body = { role: "owner" };
    (req as unknown as { query: unknown }).query = { role: "owner" };
    const next = vi.fn() as unknown as NextFunction;

    requirePermission("member.manage")(req, {} as Response, next);

    expect(errorFrom(next as unknown as ReturnType<typeof vi.fn>)).toBeInstanceOf(InsufficientPermissionError);
  });
});
