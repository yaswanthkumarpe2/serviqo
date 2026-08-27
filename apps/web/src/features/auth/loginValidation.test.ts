import { describe, expect, it } from "vitest";

import { hasFieldErrors, validateLogin } from "./loginValidation";

describe("validateLogin", () => {
  const valid = { email: "ada@example.com", password: "correct-horse-battery" };

  it("accepts a well-formed pair", () => {
    expect(validateLogin(valid)).toEqual({});
    expect(hasFieldErrors(validateLogin(valid))).toBe(false);
  });

  it("requires an email", () => {
    expect(validateLogin({ ...valid, email: "" }).email).toBe("Email is required");
  });

  it("treats a whitespace-only email as missing", () => {
    expect(validateLogin({ ...valid, email: "   " }).email).toBe("Email is required");
  });

  it.each(["not-an-address", "missing@tld", "@example.com", "spaces in@example.com"])(
    "rejects the malformed address %s",
    (email) => {
      expect(validateLogin({ ...valid, email }).email).toBe("Enter a valid email address");
    },
  );

  it("requires a password", () => {
    expect(validateLogin({ ...valid, password: "" }).password).toBe("Password is required");
  });

  /**
   * ADR-011 §3: the server deliberately does not apply the registration
   * length policy at login. Duplicating it here would leak the policy and
   * split one generic failure into two distinguishable ones.
   */
  it("does not apply a password length policy", () => {
    expect(validateLogin({ ...valid, password: "a" })).toEqual({});
  });

  it("accepts a password that is only whitespace, since that is a wrong password not a malformed one", () => {
    expect(validateLogin({ ...valid, password: "   " })).toEqual({});
  });

  it("reports both fields at once", () => {
    const errors = validateLogin({ email: "", password: "" });
    expect(Object.keys(errors).sort()).toEqual(["email", "password"]);
  });
});
