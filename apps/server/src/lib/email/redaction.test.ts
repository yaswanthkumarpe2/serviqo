import { describe, expect, it } from "vitest";

import { describeActionUrl, maskEmailAddress } from "./redaction";

/** Obvious sentinel — if this string ever reaches a log, the test fails loudly. */
const SECRET = "DO_NOT_LOG_THIS_SECRET";

describe("describeActionUrl", () => {
  it("keeps origin and pathname", () => {
    const result = describeActionUrl("http://localhost:5173/verify-email?token=abc");

    expect(result.origin).toBe("http://localhost:5173");
    expect(result.path).toBe("/verify-email");
  });

  it("reports the presence of a token without capturing its value", () => {
    const withToken = describeActionUrl(`http://localhost:5173/verify-email?token=${SECRET}`);
    const withoutToken = describeActionUrl("http://localhost:5173/verify-email");

    expect(withToken.hasToken).toBe(true);
    expect(withoutToken.hasToken).toBe(false);
    expect(JSON.stringify(withToken)).not.toContain(SECRET);
  });

  it("drops every query parameter value, not just the token", () => {
    const result = describeActionUrl(
      `https://app.example.com/reset-password?token=${SECRET}&email=user%40example.com&ref=campaign`,
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("user%40example.com");
    expect(serialized).not.toContain("campaign");
    expect(result.path).toBe("/reset-password");
  });

  it("drops URL fragments", () => {
    const result = describeActionUrl(`https://app.example.com/verify-email#${SECRET}`);

    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.path).toBe("/verify-email");
  });

  it("returns a safe representation for a malformed URL instead of throwing", () => {
    expect(() => describeActionUrl("not a url at all")).not.toThrow();

    const result = describeActionUrl("not a url at all");
    expect(result.origin).toBe("(unparseable)");
    expect(result.path).toBe("(unparseable)");
    expect(result.hasToken).toBe(false);
  });

  it("never echoes a malformed URL, which may still contain a secret", () => {
    // A string that fails to parse can still hold a live token.
    const result = describeActionUrl(`::::not-a-url::::${SECRET}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rejects non-web protocols, which can smuggle a secret into the pathname", () => {
    // Regression: `new URL()` parses this happily as scheme "garbage:" with
    // the entire secret as the pathname, which the pathname branch would
    // otherwise log verbatim.
    const result = describeActionUrl(`garbage::${SECRET}`);

    expect(result.path).toBe("(unparseable)");
    expect(result.origin).toBe("(unparseable)");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rejects other non-http schemes that parse successfully", () => {
    for (const rawUrl of [
      `javascript:alert("${SECRET}")`,
      `data:text/plain,${SECRET}`,
      `mailto:${SECRET}@example.com`,
      `file:///etc/${SECRET}`,
    ]) {
      const result = describeActionUrl(rawUrl);
      expect(result.path).toBe("(unparseable)");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("still accepts ordinary http and https links", () => {
    expect(describeActionUrl("http://localhost:5173/verify-email").path).toBe("/verify-email");
    expect(describeActionUrl("https://app.example.com/reset-password").path).toBe("/reset-password");
  });

  it("handles empty input safely", () => {
    expect(() => describeActionUrl("")).not.toThrow();
    expect(describeActionUrl("").path).toBe("(unparseable)");
  });
});

describe("maskEmailAddress", () => {
  it("keeps only the first character of the local part", () => {
    expect(maskEmailAddress("yaswanth@example.com")).toBe("y***@example.com");
  });

  it("is deterministic", () => {
    expect(maskEmailAddress("someone@example.com")).toBe(maskEmailAddress("someone@example.com"));
  });

  it("does not reveal the rest of the local part", () => {
    const masked = maskEmailAddress("verysecretlocalpart@example.com");

    expect(masked).not.toContain("verysecretlocalpart");
    expect(masked).not.toContain("erysecret");
    expect(masked).toBe("v***@example.com");
  });

  it("preserves the domain, which identifies an organization rather than a person", () => {
    expect(maskEmailAddress("agent@acme-support.io")).toBe("a***@acme-support.io");
  });

  it("masks an address containing multiple @ characters using the last one", () => {
    expect(maskEmailAddress('"odd@local"@example.com')).toBe('"***@example.com');
  });

  it("reduces malformed input to *** rather than echoing it", () => {
    expect(maskEmailAddress("no-at-sign")).toBe("***");
    expect(maskEmailAddress("")).toBe("***");
    expect(maskEmailAddress("@example.com")).toBe("***");
    expect(maskEmailAddress("local@")).toBe("***");
  });

  it("never throws for unusual input", () => {
    for (const input of ["", "@", "a@", "@b", "a@b", "🔥@example.com"]) {
      expect(() => maskEmailAddress(input)).not.toThrow();
    }
  });
});
