import { describe, expect, it } from "vitest";

import { describeActionUrl, maskEmailAddress } from "./redaction";

/** Obvious sentinel — if this string ever reaches a log, the test fails loudly. */
const SECRET = "DO_NOT_LOG_THIS_SECRET";

describe("describeActionUrl", () => {
  describe("action classification", () => {
    it("maps a known verification URL to the verify-email action", () => {
      expect(describeActionUrl("http://localhost:5173/verify-email?token=abc").action).toBe("verify-email");
    });

    it("maps a known password-reset URL to the password-reset action", () => {
      expect(describeActionUrl("http://localhost:5173/reset-password?token=abc").action).toBe("password-reset");
    });

    it("maps known invitation URLs to the invitation action", () => {
      expect(describeActionUrl("http://localhost:5173/accept-invitation?token=abc").action).toBe("invitation");
      expect(describeActionUrl("http://localhost:5173/invitations?token=abc").action).toBe("invitation");
    });

    it("classifies consistently regardless of case or trailing slash", () => {
      expect(describeActionUrl("http://localhost:5173/Verify-Email").action).toBe("verify-email");
      expect(describeActionUrl("http://localhost:5173/verify-email/").action).toBe("verify-email");
    });

    it("classifies an unknown path as unknown without echoing it", () => {
      const result = describeActionUrl("https://app.example.com/some/unexpected/route");

      expect(result.action).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("unexpected");
      expect(JSON.stringify(result)).not.toContain("route");
    });

    it("retains origin only for valid http/https URLs", () => {
      expect(describeActionUrl("https://app.example.com/verify-email").origin).toBe("https://app.example.com");
      expect(describeActionUrl("http://localhost:5173/verify-email").origin).toBe("http://localhost:5173");
      expect(describeActionUrl("garbage::x").origin).toBe("(unparseable)");
    });
  });

  describe("secret containment", () => {
    it("never leaks a secret in the token query parameter", () => {
      const result = describeActionUrl(`http://localhost:5173/verify-email?token=${SECRET}`);

      expect(result.hasToken).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("never leaks a secret in any other query parameter", () => {
      const result = describeActionUrl(
        `https://app.example.com/reset-password?email=user%40example.com&ref=${SECRET}&campaign=x`,
      );
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("user@example.com");
      expect(serialized).not.toContain("user%40example.com");
      expect(serialized).not.toContain("campaign");
    });

    it("never leaks a secret in a URL fragment", () => {
      const result = describeActionUrl(`https://app.example.com/verify-email#${SECRET}`);

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.action).toBe("verify-email");
    });

    it("never leaks a secret placed in a pathname segment", () => {
      // The hardening case: a caller building /verify-email/SECRET must not
      // be able to put it in a log just by constructing the URL that way.
      const result = describeActionUrl(`https://app.example.com/verify-email/${SECRET}?x=1`);

      expect(JSON.stringify(result)).not.toContain(SECRET);
      // Exact match only, so an extra segment fails closed rather than
      // being treated as a known action.
      expect(result.action).toBe("unknown");
    });

    it("never leaks a secret placed in the final pathname segment of a deep path", () => {
      const result = describeActionUrl(`https://app.example.com/auth/v1/verify/${SECRET}`);

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.action).toBe("unknown");
    });

    it("never leaks a secret spread across multiple path segments", () => {
      const result = describeActionUrl(`https://app.example.com/${SECRET}/verify-email/${SECRET}`);

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.action).toBe("unknown");
    });

    it("never leaks a secret from a malformed URL", () => {
      const result = describeActionUrl(`::::not-a-url::::${SECRET}`);

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.action).toBe("unknown");
    });

    it("never leaks a secret from non-web protocols that parse successfully", () => {
      for (const rawUrl of [
        `garbage::${SECRET}`,
        `javascript:alert("${SECRET}")`,
        `data:text/plain,${SECRET}`,
        `mailto:${SECRET}@example.com`,
        `file:///etc/${SECRET}`,
      ]) {
        const result = describeActionUrl(rawUrl);

        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(result.action).toBe("unknown");
        expect(result.origin).toBe("(unparseable)");
      }
    });

    it("never returns the raw URL in any field", () => {
      const rawUrl = `https://app.example.com/verify-email?token=${SECRET}#frag`;
      const result = describeActionUrl(rawUrl);

      expect(JSON.stringify(result)).not.toContain(rawUrl);
      expect(JSON.stringify(result)).not.toContain("frag");
    });

    it("only ever emits values from the closed action set", () => {
      const allowed = new Set(["verify-email", "password-reset", "invitation", "unknown"]);
      const inputs = [
        `https://app.example.com/verify-email?token=${SECRET}`,
        `https://app.example.com/${SECRET}`,
        `garbage::${SECRET}`,
        "not a url",
        "",
      ];

      for (const input of inputs) {
        expect(allowed.has(describeActionUrl(input).action)).toBe(true);
      }
    });
  });

  describe("robustness", () => {
    it("does not throw for a malformed URL", () => {
      expect(() => describeActionUrl("not a url at all")).not.toThrow();
      expect(describeActionUrl("not a url at all").action).toBe("unknown");
    });

    it("handles empty input safely", () => {
      expect(() => describeActionUrl("")).not.toThrow();
      expect(describeActionUrl("").action).toBe("unknown");
      expect(describeActionUrl("").origin).toBe("(unparseable)");
    });
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
