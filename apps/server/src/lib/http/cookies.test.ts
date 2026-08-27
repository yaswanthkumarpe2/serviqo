import { describe, expect, it } from "vitest";

import { readCookie } from "./cookies";

const NAME = "serviqo_refresh";

describe("readCookie", () => {
  it("reads the only cookie in the header", () => {
    expect(readCookie(`${NAME}=abc.def`, NAME)).toBe("abc.def");
  });

  it("finds the cookie among others regardless of position", () => {
    const header = `theme=dark; ${NAME}=abc.def; locale=en`;
    expect(readCookie(header, NAME)).toBe("abc.def");
  });

  it("tolerates the spacing browsers actually send", () => {
    expect(readCookie(`theme=dark;${NAME}=abc.def`, NAME)).toBe("abc.def");
    expect(readCookie(`theme=dark;   ${NAME}=abc.def`, NAME)).toBe("abc.def");
  });

  it("returns undefined when the header is absent or empty", () => {
    expect(readCookie(undefined, NAME)).toBeUndefined();
    expect(readCookie("", NAME)).toBeUndefined();
  });

  it("returns undefined when no cookie has that name", () => {
    expect(readCookie("theme=dark; locale=en", NAME)).toBeUndefined();
  });

  // A prefix match would let `serviqo_refresh_backup` answer for the real one.
  it("matches the name exactly, not by prefix or suffix", () => {
    expect(readCookie(`${NAME}_backup=nope`, NAME)).toBeUndefined();
    expect(readCookie(`x_${NAME}=nope`, NAME)).toBeUndefined();
  });

  it("treats an empty value as no cookie", () => {
    expect(readCookie(`${NAME}=`, NAME)).toBeUndefined();
    expect(readCookie(`${NAME}=   `, NAME)).toBeUndefined();
  });

  it("ignores a malformed pair carrying no '='", () => {
    expect(readCookie(`garbage; ${NAME}=abc.def`, NAME)).toBe("abc.def");
    expect(readCookie("garbage", NAME)).toBeUndefined();
  });

  // Splitting on the last '=' would truncate a value that contains one.
  it("splits on the first '=' so the value survives intact", () => {
    expect(readCookie(`${NAME}=abc=def=ghi`, NAME)).toBe("abc=def=ghi");
  });

  it("decodes percent-encoded values, since res.cookie encodes them", () => {
    expect(readCookie(`${NAME}=a%20b`, NAME)).toBe("a b");
  });

  // An attacker-controlled header must not reach decodeURIComponent's throw.
  it("returns a malformed percent-escape raw instead of throwing", () => {
    expect(() => readCookie(`${NAME}=100%`, NAME)).not.toThrow();
    expect(readCookie(`${NAME}=100%`, NAME)).toBe("100%");
  });

  it("returns the first match when a name is repeated", () => {
    expect(readCookie(`${NAME}=first; ${NAME}=second`, NAME)).toBe("first");
  });
});
