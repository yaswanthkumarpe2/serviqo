import { describe, expect, it } from "vitest";

import { transferOwnershipSchema } from "./ownership.validation";

/**
 * Schema coverage for ownership transfer (ADR-028 §4).
 *
 * The stripping assertions are the security-relevant half. `validateBody`
 * REPLACES `req.body` with the schema's output, so a key that does not survive
 * parsing never becomes observable to a controller — which is why no handler,
 * service, or repository in this slice contains a comparison defending against
 * a forged `organizationId`, `currentOwnerId`, or `role`. There is nothing to
 * compare, and these tests are what prove that claim rather than assume it.
 */

const VALID_ID = "507f1f77bcf86cd799439011";

describe("transferOwnershipSchema", () => {
  it("accepts a well-formed membership id", () => {
    const result = transferOwnershipSchema.safeParse({ membershipId: VALID_ID });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ membershipId: VALID_ID });
  });

  it("accepts an uppercase hex id", () => {
    const upper = VALID_ID.toUpperCase();

    expect(transferOwnershipSchema.safeParse({ membershipId: upper }).data).toEqual({ membershipId: upper });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(transferOwnershipSchema.safeParse({ membershipId: `  ${VALID_ID}  ` }).data).toEqual({
      membershipId: VALID_ID,
    });
  });

  it("requires the field", () => {
    expect(transferOwnershipSchema.safeParse({}).success).toBe(false);
  });

  /*
    Rejected in the SCHEMA rather than in the service, so a malformed id is a
    400 before any query runs. A malformed value reaching `Mongoose.findOne`
    raises a `CastError`, which `errorHandler` turns into a generic 500 —
    reporting a client's mistyped id as a server fault.
  */
  it.each([
    ["too short", "507f1f77bcf86cd79943901"],
    ["too long", "507f1f77bcf86cd7994390111"],
    ["non-hex", "507f1f77bcf86cd7994390zz"],
    ["empty", ""],
    ["a slug", "acme-support"],
    ["an injection attempt", '{"$ne":null}'],
  ])("rejects %s", (_label, membershipId) => {
    expect(transferOwnershipSchema.safeParse({ membershipId }).success).toBe(false);
  });

  it.each([[42], [null], [{}], [["507f1f77bcf86cd799439011"]], [true]])(
    "rejects a non-string value (%j)",
    (membershipId) => {
      expect(transferOwnershipSchema.safeParse({ membershipId }).success).toBe(false);
    },
  );

  // ---- ADR-028 §4: forged identity fields are STRIPPED, not rejected ----

  it("strips a forged organizationId", () => {
    const result = transferOwnershipSchema.safeParse({
      membershipId: VALID_ID,
      organizationId: "507f1f77bcf86cd799439099",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ membershipId: VALID_ID });
    expect(result.data).not.toHaveProperty("organizationId");
  });

  it("strips a forged currentOwnerId", () => {
    const result = transferOwnershipSchema.safeParse({
      membershipId: VALID_ID,
      currentOwnerId: "507f1f77bcf86cd799439099",
      ownerUserId: "507f1f77bcf86cd799439098",
    });

    expect(result.data).toEqual({ membershipId: VALID_ID });
  });

  it("strips a forged role and status", () => {
    const result = transferOwnershipSchema.safeParse({
      membershipId: VALID_ID,
      role: "owner",
      status: "active",
    });

    expect(result.data).toEqual({ membershipId: VALID_ID });
  });

  /*
    One assertion covering every identity field at once, so a key added to the
    schema by accident fails here rather than in an integration test that may
    not think to send it.
  */
  it("keeps exactly one key, whatever else is sent", () => {
    const result = transferOwnershipSchema.safeParse({
      membershipId: VALID_ID,
      organizationId: "x",
      currentOwnerId: "x",
      userId: "x",
      invitedByUserId: "x",
      role: "owner",
      status: "active",
      permissions: ["organization.transfer_ownership"],
      __proto__: { polluted: true },
    });

    expect(Object.keys(result.data!)).toEqual(["membershipId"]);
  });
});
