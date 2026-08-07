import { describe, expect, it } from "vitest";

import { registerSchema } from "./auth.validation";

const validInput = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "correct-horse-battery",
};

/** Field paths of every issue, so a case can assert which field failed. */
function failedFields(input: unknown): string[] {
  const result = registerSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("registerSchema — accepted input", () => {
  it("accepts a valid registration", () => {
    const result = registerSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("strips keys the schema does not declare", () => {
    const result = registerSchema.parse({
      ...validInput,
      status: "disabled",
      emailVerifiedAt: new Date().toISOString(),
      failedLoginAttempts: 99,
      role: "owner",
    });

    expect(Object.keys(result).sort()).toEqual(["email", "name", "password"]);
  });
});

describe("registerSchema — required fields", () => {
  it.each(["name", "email", "password"])("rejects a missing %s", (field) => {
    const input: Record<string, unknown> = { ...validInput };
    delete input[field];

    expect(failedFields(input)).toContain(field);
  });

  it("rejects a body that is not an object", () => {
    expect(registerSchema.safeParse(undefined).success).toBe(false);
    expect(registerSchema.safeParse("a string").success).toBe(false);
  });
});

describe("registerSchema — email", () => {
  it.each(["not-an-email", "missing@tld", "@example.com", "spaces in@example.com", "double@@example.com"])(
    "rejects malformed address %s",
    (email) => {
      expect(failedFields({ ...validInput, email })).toContain("email");
    },
  );

  it("trims surrounding whitespace before validating", () => {
    const result = registerSchema.parse({ ...validInput, email: "   ada@example.com   " });
    expect(result.email).toBe("ada@example.com");
  });

  it("rejects an address longer than 254 characters", () => {
    const local = "a".repeat(250);
    expect(failedFields({ ...validInput, email: `${local}@example.com` })).toContain("email");
  });

  // normalizeEmail (user.model.ts) is the single canonicalization authority;
  // a second one here would be free to drift from it.
  it("does not lowercase — canonicalization belongs to the User model", () => {
    const result = registerSchema.parse({ ...validInput, email: "Ada@Example.COM" });
    expect(result.email).toBe("Ada@Example.COM");
  });
});

describe("registerSchema — name", () => {
  it("rejects an empty name", () => {
    expect(failedFields({ ...validInput, name: "" })).toContain("name");
  });

  it("rejects a name that is only whitespace", () => {
    expect(failedFields({ ...validInput, name: "     " })).toContain("name");
  });

  it("trims surrounding whitespace", () => {
    const result = registerSchema.parse({ ...validInput, name: "  Ada Lovelace  " });
    expect(result.name).toBe("Ada Lovelace");
  });

  it("accepts a name of exactly 100 characters", () => {
    expect(registerSchema.safeParse({ ...validInput, name: "a".repeat(100) }).success).toBe(true);
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
    expect(registerSchema.safeParse({ ...validInput, name }).success).toBe(true);
  });

  // Zero canonicalization: a name is presentation data belonging to its owner.
  it("does not normalize an accepted name", () => {
    const decomposed = "Jose\u0301 Alvarez";
    const result = registerSchema.parse({ ...validInput, name: decomposed });

    expect(result.name).toBe(decomposed);
    expect(result.name).not.toBe(decomposed.normalize("NFC"));
  });
});

describe("registerSchema — password length", () => {
  it("rejects a password of 9 code points", () => {
    expect(failedFields({ ...validInput, password: "a".repeat(9) })).toContain("password");
  });

  it("accepts a password of exactly 10 code points", () => {
    expect(registerSchema.safeParse({ ...validInput, password: "a".repeat(10) }).success).toBe(true);
  });

  it("accepts a password of exactly 128 code points", () => {
    expect(registerSchema.safeParse({ ...validInput, password: "a".repeat(128) }).success).toBe(true);
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
    expect(registerSchema.safeParse({ ...validInput, password: "\u{1F600}".repeat(10) }).success).toBe(true);
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

describe("registerSchema — password is never transformed", () => {
  it("preserves leading and trailing whitespace", () => {
    const password = "   spaced password   ";
    expect(registerSchema.parse({ ...validInput, password }).password).toBe(password);
  });

  it("preserves internal whitespace and case", () => {
    const password = "MiXeD Case\tWith\tTabs";
    expect(registerSchema.parse({ ...validInput, password }).password).toBe(password);
  });

  // The composed form is measured, but the decomposed form is what comes
  // back — NFC ownership stays inside the crypto boundary.
  it("does not NFC-normalize the returned password", () => {
    const decomposed = "cafe\u0301-password-long";
    const result = registerSchema.parse({ ...validInput, password: decomposed });

    expect(result.password).toBe(decomposed);
    expect(result.password).not.toBe(decomposed.normalize("NFC"));
  });
});

describe("registerSchema — issue messages", () => {
  it("never echoes the submitted value in a message", () => {
    const password = "sh0rt";
    const email = "leak-me@@example";
    const result = registerSchema.safeParse({ name: "\u0000bad", email, password });

    expect(result.success).toBe(false);
    if (result.success) return;

    const messages = result.error.issues.map((issue) => issue.message).join(" | ");
    expect(messages).not.toContain(password);
    expect(messages).not.toContain(email);
    expect(messages).not.toContain("bad");
  });
});
