import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  chosenPasswordField,
  emailField,
  loginSchema,
  personNameField,
  resendVerificationSchema,
  verifyEmailSchema,
} from "./auth.validation";

/**
 * The three account fields, composed the way registration composed them
 * before ADR-037 removed it. They are tested together because they are still
 * used — by invitations and password reset — and the rules were written, and
 * are easiest to read, as one form.
 */
const accountFields = z.object({ name: personNameField, email: emailField, password: chosenPasswordField });

const validInput = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "correct-horse-battery",
};

/** Field paths of every issue, so a case can assert which field failed. */
function failedFields(input: unknown): string[] {
  const result = accountFields.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("accountFields — accepted input", () => {
  it("accepts valid account fields", () => {
    const result = accountFields.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("strips keys the schema does not declare", () => {
    const result = accountFields.parse({
      ...validInput,
      status: "disabled",
      emailVerifiedAt: new Date().toISOString(),
      failedLoginAttempts: 99,
      role: "owner",
    });

    expect(Object.keys(result).sort()).toEqual(["email", "name", "password"]);
  });
});

describe("accountFields — required fields", () => {
  it.each(["name", "email", "password"])("rejects a missing %s", (field) => {
    const input: Record<string, unknown> = { ...validInput };
    delete input[field];

    expect(failedFields(input)).toContain(field);
  });

  it("rejects a body that is not an object", () => {
    expect(accountFields.safeParse(undefined).success).toBe(false);
    expect(accountFields.safeParse("a string").success).toBe(false);
  });
});

describe("accountFields — email", () => {
  it.each(["not-an-email", "missing@tld", "@example.com", "spaces in@example.com", "double@@example.com"])(
    "rejects malformed address %s",
    (email) => {
      expect(failedFields({ ...validInput, email })).toContain("email");
    },
  );

  it("trims surrounding whitespace before validating", () => {
    const result = accountFields.parse({ ...validInput, email: "   ada@example.com   " });
    expect(result.email).toBe("ada@example.com");
  });

  it("rejects an address longer than 254 characters", () => {
    const local = "a".repeat(250);
    expect(failedFields({ ...validInput, email: `${local}@example.com` })).toContain("email");
  });

  // normalizeEmail (user.model.ts) is the single canonicalization authority;
  // a second one here would be free to drift from it.
  it("does not lowercase — canonicalization belongs to the User model", () => {
    const result = accountFields.parse({ ...validInput, email: "Ada@Example.COM" });
    expect(result.email).toBe("Ada@Example.COM");
  });
});

describe("accountFields — name", () => {
  it("rejects an empty name", () => {
    expect(failedFields({ ...validInput, name: "" })).toContain("name");
  });

  it("rejects a name that is only whitespace", () => {
    expect(failedFields({ ...validInput, name: "     " })).toContain("name");
  });

  it("trims surrounding whitespace", () => {
    const result = accountFields.parse({ ...validInput, name: "  Ada Lovelace  " });
    expect(result.name).toBe("Ada Lovelace");
  });

  it("accepts a name of exactly 100 characters", () => {
    expect(accountFields.safeParse({ ...validInput, name: "a".repeat(100) }).success).toBe(true);
  });

  it("rejects a name of 101 characters", () => {
    expect(failedFields({ ...validInput, name: "a".repeat(101) })).toContain("name");
  });

  // A bare CR or LF in a display name is a header-injection primitive once
  // the name reaches a real email envelope.
  it.each([
    ["carriage return", "Ada\rLovelace"],
    ["line feed", "Ada\nLovelace"],
    ["null byte", "Ada\u0000Lovelace"],
    ["escape", "Ada\u001BLovelace"],
    ["C1 control", "Ada\u0085Lovelace"],
    ["delete", "Ada\u007FLovelace"],
  ])("rejects a name containing a %s", (_label, name) => {
    expect(failedFields({ ...validInput, name })).toContain("name");
  });

  it.each([
    ["accented Latin", "José Álvarez"],
    ["decomposed accent", "Jose\u0301 Alvarez"],
    ["Cyrillic", "Анна Петрова"],
    ["Han", "张伟"],
    ["Arabic", "يوسف"],
    ["Devanagari", "यशवंत"],
    ["emoji", "Ada \u{1F600}"],
  ])("accepts a %s name", (_label, name) => {
    expect(accountFields.safeParse({ ...validInput, name }).success).toBe(true);
  });

  // Zero canonicalization: a name is presentation data belonging to its owner.
  it("does not normalize an accepted name", () => {
    const decomposed = "Jose\u0301 Alvarez";
    const result = accountFields.parse({ ...validInput, name: decomposed });

    expect(result.name).toBe(decomposed);
    expect(result.name).not.toBe(decomposed.normalize("NFC"));
  });
});

describe("accountFields — password length", () => {
  it("rejects a password of 9 code points", () => {
    expect(failedFields({ ...validInput, password: "a".repeat(9) })).toContain("password");
  });

  it("accepts a password of exactly 10 code points", () => {
    expect(accountFields.safeParse({ ...validInput, password: "a".repeat(10) }).success).toBe(true);
  });

  it("accepts a password of exactly 128 code points", () => {
    expect(accountFields.safeParse({ ...validInput, password: "a".repeat(128) }).success).toBe(true);
  });

  it("rejects a password of 129 code points", () => {
    expect(failedFields({ ...validInput, password: "a".repeat(129) })).toContain("password");
  });

  /**
   * The regression this schema exists to prevent: each emoji is one code
   * point but two UTF-16 code units. Zod's own .min()/.max() would count 12
   * and accept it, then hashPassword would count 6 and throw — a 500 on
   * input the schema had just called valid.
   */
  it("measures code points, not UTF-16 code units, for astral characters", () => {
    const sixEmoji = "\u{1F600}".repeat(6);
    expect([...sixEmoji]).toHaveLength(6);
    expect(sixEmoji.length).toBe(12);

    expect(failedFields({ ...validInput, password: sixEmoji })).toContain("password");
  });

  it("accepts 10 astral characters", () => {
    expect(accountFields.safeParse({ ...validInput, password: "\u{1F600}".repeat(10) }).success).toBe(true);
  });

  it("rejects 129 astral characters", () => {
    expect(failedFields({ ...validInput, password: "\u{1F600}".repeat(129) })).toContain("password");
  });

  // The hasher measures the composed form, so validation must too: 12
  // decomposed code points compose to 6 and would otherwise be rejected by
  // hashPassword after passing here.
  it("measures the NFC-composed form, matching hashPassword", () => {
    const decomposed = "e\u0301".repeat(6);
    expect([...decomposed]).toHaveLength(12);
    expect([...decomposed.normalize("NFC")]).toHaveLength(6);

    expect(failedFields({ ...validInput, password: decomposed })).toContain("password");
  });
});

describe("accountFields — password is never transformed", () => {
  it("preserves leading and trailing whitespace", () => {
    const password = "   spaced password   ";
    expect(accountFields.parse({ ...validInput, password }).password).toBe(password);
  });

  it("preserves internal whitespace and case", () => {
    const password = "MiXeD Case\tWith\tTabs";
    expect(accountFields.parse({ ...validInput, password }).password).toBe(password);
  });

  // The composed form is measured, but the decomposed form is what comes
  // back — NFC ownership stays inside the crypto boundary.
  it("does not NFC-normalize the returned password", () => {
    const decomposed = "cafe\u0301-password-long";
    const result = accountFields.parse({ ...validInput, password: decomposed });

    expect(result.password).toBe(decomposed);
    expect(result.password).not.toBe(decomposed.normalize("NFC"));
  });
});

describe("resendVerificationSchema", () => {
  it("accepts an address on its own", () => {
    expect(resendVerificationSchema.safeParse({ email: "ada@example.com" }).success).toBe(true);
  });

  it("requires the address", () => {
    const result = resendVerificationSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("email");
    }
  });

  it.each(["not-an-email", "@example.com", "double@@example.com", ""])("rejects %s", (email) => {
    expect(resendVerificationSchema.safeParse({ email }).success).toBe(false);
  });

  it("applies the same 254-character bound as registration", () => {
    const tooLong = `${"a".repeat(250)}@example.com`;
    expect(resendVerificationSchema.safeParse({ email: tooLong }).success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    expect(resendVerificationSchema.parse({ email: "  ada@example.com  " }).email).toBe("ada@example.com");
  });

  // Same rule as registration: normalizeEmail owns canonicalization.
  it("does not lowercase", () => {
    expect(resendVerificationSchema.parse({ email: "Ada@Example.COM" }).email).toBe("Ada@Example.COM");
  });

  // An unauthenticated endpoint that emails a link accepts the smallest
  // possible input; anything extra is dropped before a service sees it.
  it("strips every key other than email", () => {
    const result = resendVerificationSchema.parse({
      email: "ada@example.com",
      password: "should-be-dropped",
      emailVerifiedAt: null,
      redirect: "https://evil.example.com",
    });

    expect(Object.keys(result)).toEqual(["email"]);
  });

  it("never echoes the submitted address in a message", () => {
    const result = resendVerificationSchema.safeParse({ email: "leak-me@@example" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(" ")).not.toContain("leak-me");
    }
  });
});

describe("verifyEmailSchema", () => {
  const VALID = { email: "yaswanth@example.com", code: "481920" };

  it("accepts an address and a six-digit code", () => {
    expect(verifyEmailSchema.safeParse(VALID).success).toBe(true);
  });

  /*
    Both halves are required, and the reason is structural rather than
    defensive. A six-digit code identifies nothing on its own — a million
    codes are shared among every pending account — so the address is what
    selects the token and the code is what proves possession (ADR-030 §5).
  */
  it("requires the email", () => {
    expect(verifyEmailSchema.safeParse({ code: "481920" }).success).toBe(false);
  });

  it("requires the code", () => {
    expect(verifyEmailSchema.safeParse({ email: VALID.email }).success).toBe(false);
  });

  /*
    Shape is refused here, before any lookup, so a typo cannot spend one of
    the five guesses a real code is allowed. Without this a fumbling user
    would lock themselves out faster than an attacker would.
  */
  it.each([
    ["five digits", "48192"],
    ["seven digits", "4819201"],
    ["empty", ""],
    ["letters", "4819ab"],
    ["punctuation", "481-92"],
    ["a space inside", "481 920"],
  ])("rejects %s", (_label, code) => {
    expect(verifyEmailSchema.safeParse({ ...VALID, code }).success).toBe(false);
  });

  // Leading zeros are significant: 042931 is a legitimate code, and losing
  // them would halve the space for every code that starts with one.
  it("accepts a code with leading zeros", () => {
    expect(verifyEmailSchema.parse({ ...VALID, code: "042931" }).code).toBe("042931");
  });

  // Digits carry no whitespace, so trimming can only repair a pasted value
  // and can never alter a real code.
  it("trims surrounding whitespace", () => {
    expect(verifyEmailSchema.parse({ ...VALID, code: "  481920  " }).code).toBe("481920");
  });

  /*
    Trimmed but NOT lowercased, matching `emailField` and therefore every
    other schema in this module. Canonicalization to lowercase happens at the
    model boundary (`normalizeEmail`), which is the one place that decision
    lives — a schema that lowercased too would be a second, drifting copy.
  */
  it("trims the email the same way every other schema does", () => {
    expect(verifyEmailSchema.parse({ ...VALID, email: "  ada@example.com " }).email).toBe("ada@example.com");
  });
});

describe("accountFields — issue messages", () => {
  it("never echoes the submitted value in a message", () => {
    const password = "sh0rt";
    const email = "leak-me@@example";
    const result = accountFields.safeParse({ name: "\u0000bad", email, password });

    expect(result.success).toBe(false);
    if (result.success) return;

    const messages = result.error.issues.map((issue) => issue.message).join(" | ");
    expect(messages).not.toContain(password);
    expect(messages).not.toContain(email);
    expect(messages).not.toContain("bad");
  });
});

describe("loginSchema", () => {
  const credentials = { email: "ada@example.com", password: "correct-horse-battery" };

  it("accepts an address and a password", () => {
    expect(loginSchema.safeParse(credentials).success).toBe(true);
  });

  it("trims the address but never the password", () => {
    const result = loginSchema.safeParse({ email: "  ada@example.com ", password: "  spaced  " });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.email).toBe("ada@example.com");
    expect(result.data.password).toBe("  spaced  ");
  });

  /**
   * A short password is wrong, not malformed. Applying the registration
   * length policy here would leak that policy to an unauthenticated caller
   * and split login's single generic failure into two distinguishable ones
   * (ADR-011 section 3).
   */
  it("does not apply the registration length policy", () => {
    expect(loginSchema.safeParse({ ...credentials, password: "a" }).success).toBe(true);
  });

  it("requires the password to be present", () => {
    expect(loginSchema.safeParse({ email: credentials.email, password: "" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: credentials.email }).success).toBe(false);
  });

  it("rejects a malformed address", () => {
    expect(loginSchema.safeParse({ ...credentials, email: "not-an-address" }).success).toBe(false);
  });

  // Zod strips unknown keys, so a client cannot smuggle account state through.
  it("strips unrecognized keys", () => {
    const result = loginSchema.safeParse({ ...credentials, status: "active", emailVerifiedAt: new Date() });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data).sort()).toEqual(["email", "password"]);
  });

  it("never echoes the submitted password in a failure message", () => {
    const password = "DO_NOT_LEAK_THIS_PASSWORD";
    const result = loginSchema.safeParse({ email: "not-an-address", password });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message).join(" | ")).not.toContain(password);
  });
});
