import { describe, expect, it } from "vitest";

import {
  isReservedSlug,
  isWellFormedSlug,
  slugCandidate,
  slugifyOrganizationName,
} from "./organizationSlug";

/** The schema's own pattern, restated so a drift between the two fails here. */
const SCHEMA_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugifyOrganizationName", () => {
  it.each([
    ["Acme", "acme"],
    ["Acme Corp", "acme-corp"],
    ["ACME CORP", "acme-corp"],
    ["  Acme  Corp  ", "acme-corp"],
    ["Acme, Inc.", "acme-inc"],
    ["Acme & Sons", "acme-sons"],
    ["Acme---Corp", "acme-corp"],
    ["Acme 2026", "acme-2026"],
    ["2026", "2026"],
    ["a", "a"],
  ])("turns %j into %j", (name, expected) => {
    expect(slugifyOrganizationName(name)).toBe(expected);
  });

  // NFKD decomposition plus combining-mark removal, so a European name
  // reaches a usable segment rather than losing its accented characters.
  it.each([
    ["Café Berlin", "cafe-berlin"],
    ["Ünïcode Ltd", "unicode-ltd"],
    ["Zürich Süd", "zurich-sud"],
    ["Ångström", "angstrom"],
  ])("folds diacritics: %j becomes %j", (name, expected) => {
    expect(slugifyOrganizationName(name)).toBe(expected);
  });

  it("never yields a leading or trailing hyphen", () => {
    for (const name of ["...Acme...", "---Acme---", "  !Acme!  ", "@Acme@"]) {
      const slug = slugifyOrganizationName(name);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });

  /*
    A name in a script the ASCII fold erases must still produce a creatable
    organization. Falling back is deliberate (ADR-016 §5): the name is
    presentation data belonging to its owner and should not have to be Latin
    script for the tenant to exist.
  */
  it.each([["~~~"], ["!!!"], ["   "], ["日本語"], ["مرحبا"], ["🎉🎉"]])(
    "falls back to a usable base for %j rather than failing",
    (name) => {
      const slug = slugifyOrganizationName(name);

      expect(slug.length).toBeGreaterThan(0);
      expect(SCHEMA_SLUG_PATTERN.test(slug)).toBe(true);
    },
  );

  it("bounds the length of the generated base", () => {
    const slug = slugifyOrganizationName("A".repeat(200));

    expect(slug.length).toBeLessThanOrEqual(48);
    expect(SCHEMA_SLUG_PATTERN.test(slug)).toBe(true);
  });

  // The cut can land on a hyphen; the result must still be well-formed.
  it("stays well-formed when the length bound truncates mid-word", () => {
    const name = `${"ab ".repeat(40)}`;

    const slug = slugifyOrganizationName(name);

    expect(slug.endsWith("-")).toBe(false);
    expect(SCHEMA_SLUG_PATTERN.test(slug)).toBe(true);
  });

  /*
    The property that matters most: whatever the generator emits, the schema
    must accept. A disagreement here is a Mongoose ValidationError from
    persistence — a 500 on a perfectly valid name (ADR-016 §5).
  */
  it("always produces something the schema pattern accepts", () => {
    const names = [
      "Acme",
      "Acme Corp",
      "Café Berlin",
      "~~~",
      "日本語",
      "A".repeat(200),
      "!@#$%^&*()",
      "9",
      "-leading",
      "trailing-",
      "  ",
      "Ünïcode --- Ltd...",
      "🎉 Party 🎉",
    ];

    for (const name of names) {
      const slug = slugifyOrganizationName(name);
      expect(SCHEMA_SLUG_PATTERN.test(slug), `slug for ${JSON.stringify(name)} was ${JSON.stringify(slug)}`).toBe(
        true,
      );
    }
  });

  // The slug is derived from the name; it never writes back to it.
  it("is lossy and makes no claim to be reversible", () => {
    expect(slugifyOrganizationName("Acme, Inc.")).toBe(slugifyOrganizationName("Acme Inc"));
  });
});

describe("slugCandidate", () => {
  it("uses the bare base for the first attempt", () => {
    expect(slugCandidate("acme", 0)).toBe("acme");
  });

  // `acme-1` would read like the first of several when it is the second.
  it("starts visible suffixes at 2", () => {
    expect(slugCandidate("acme", 1)).toBe("acme-2");
    expect(slugCandidate("acme", 2)).toBe("acme-3");
  });

  it("produces well-formed slugs at every attempt", () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect(SCHEMA_SLUG_PATTERN.test(slugCandidate("acme", attempt))).toBe(true);
    }
  });
});

describe("isReservedSlug", () => {
  it.each([["api"], ["admin"], ["login"], ["dashboard"], ["auth"], ["health"]])(
    "reserves the route segment %j",
    (slug) => {
      expect(isReservedSlug(slug)).toBe(true);
    },
  );

  /*
    ADR-010 §5 reserved a customer-traffic namespace that does not exist yet.
    A tenant taking the segment first would collide with it on the day it
    ships, and by then the slug is in URLs.
  */
  it.each([["widget"], ["public"], ["customer"]])("reserves %j for customer traffic that does not exist yet", (slug) => {
    expect(isReservedSlug(slug)).toBe(true);
  });

  it("does not reserve an ordinary tenant name", () => {
    for (const slug of ["acme", "acme-corp", "zurich-sud", "globex"]) {
      expect(isReservedSlug(slug)).toBe(false);
    }
  });

  // The service compares generated (already lowercased) slugs, so the list
  // only ever sees lowercase input — asserted so a future caller cannot
  // assume case-insensitive matching it does not have.
  it("matches exactly, without case folding", () => {
    expect(isReservedSlug("admin")).toBe(true);
    expect(isReservedSlug("Admin")).toBe(false);
  });

  // An organization actually named "Admin" slugifies onto a reserved value,
  // which is the case §6 exists to resolve.
  it("catches the reserved value an ordinary name can produce", () => {
    expect(isReservedSlug(slugifyOrganizationName("Admin"))).toBe(true);
    expect(isReservedSlug(slugifyOrganizationName("API"))).toBe(true);
  });
});

describe("isWellFormedSlug", () => {
  it.each([["acme"], ["acme-corp"], ["a"], ["2026"], ["acme-2"]])("accepts %j", (slug) => {
    expect(isWellFormedSlug(slug)).toBe(true);
  });

  it.each([[""], ["-acme"], ["acme-"], ["acme--corp"], ["Acme"], ["acme corp"], ["acme_corp"], ["acmé"]])(
    "rejects %j",
    (slug) => {
      expect(isWellFormedSlug(slug)).toBe(false);
    },
  );

  it("agrees with the schema's pattern", () => {
    for (const slug of ["acme", "-acme", "acme-", "Acme", "acme--x", "a1-b2"]) {
      expect(isWellFormedSlug(slug)).toBe(SCHEMA_SLUG_PATTERN.test(slug));
    }
  });
});
