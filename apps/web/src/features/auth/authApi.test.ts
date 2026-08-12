import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthApiError, NETWORK_ERROR, UNEXPECTED_RESPONSE, login } from "./authApi";

const credentials = { email: "ada@example.com", password: "DO_NOT_LEAK_THIS_PASSWORD" };

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const successBody = {
  success: true,
  data: {
    user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    accessToken: "header.payload.signature",
    expiresIn: 900,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  it("posts JSON to the versioned auth path", async () => {
    const fetchMock = mockFetch(200, successBody);

    await login(credentials);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(credentials);
  });

  // The refresh cookie is SameSite=Strict and path-scoped; a request that
  // does not carry credentials would never receive it.
  it("sends credentials so the refresh cookie is accepted", async () => {
    const fetchMock = mockFetch(200, successBody);

    await login(credentials);

    expect(fetchMock.mock.calls[0]![1].credentials).toBe("same-origin");
  });

  it("unwraps the success envelope", async () => {
    mockFetch(200, successBody);

    await expect(login(credentials)).resolves.toEqual(successBody.data);
  });

  it("surfaces the server's code and message on a failure envelope", async () => {
    mockFetch(401, {
      success: false,
      error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" },
    });

    await expect(login(credentials)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "Email or password is incorrect",
      status: 401,
    });
  });

  it("carries field-level details through", async () => {
    mockFetch(400, {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: [{ field: "password", message: "Password is required" }],
      },
    });

    await expect(login(credentials)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      issues: [{ field: "password", message: "Password is required" }],
    });
  });

  it("defaults issues to an empty list when the server sends none", async () => {
    mockFetch(403, { success: false, error: { code: "EMAIL_NOT_VERIFIED", message: "Verify your email address" } });

    await expect(login(credentials)).rejects.toMatchObject({ issues: [] });
  });

  it("names a transport failure without leaking its cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch http://internal-host:3001")),
    );

    const error = await login(credentials).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AuthApiError);
    expect((error as AuthApiError).code).toBe(NETWORK_ERROR);
    expect((error as AuthApiError).message).not.toContain("internal-host");
  });

  it("rejects a non-envelope body rather than trusting it", async () => {
    mockFetch(200, { token: "not-our-shape" });

    await expect(login(credentials)).rejects.toMatchObject({ code: UNEXPECTED_RESPONSE });
  });

  it("rejects an error response whose body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error("no json")) } as Response),
    );

    await expect(login(credentials)).rejects.toMatchObject({ code: UNEXPECTED_RESPONSE, status: 502 });
  });
});
