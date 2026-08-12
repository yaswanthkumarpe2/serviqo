import { afterEach, describe, expect, it, vi } from "vitest";

import { authorizedRequest } from "./authorizedRequest";

/** Obvious sentinels — an assertion reading the wrong one should be unmissable. */
const EXPIRED_TOKEN = "EXPIRED_ACCESS_TOKEN";
const FRESH_TOKEN = "FRESH_ACCESS_TOKEN";
const PATH = "/api/v1/conversations";

function respondWith(...statuses: number[]) {
  const fetchMock = vi.fn();
  for (const status of statuses) {
    fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status } as Response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function authorizationOf(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): unknown {
  const init = fetchMock.mock.calls[callIndex]![1] as RequestInit;
  return (init.headers as Record<string, unknown> | undefined)?.Authorization;
}

/** A context whose refresh always succeeds, counting how often it was asked. */
function workingContext() {
  const refreshAccessToken = vi.fn().mockResolvedValue(FRESH_TOKEN);
  return {
    refreshAccessToken,
    context: { getAccessToken: () => EXPIRED_TOKEN, refreshAccessToken },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorizedRequest", () => {
  describe("an ordinary request", () => {
    it("presents the access token as a bearer credential", async () => {
      const fetchMock = respondWith(200);

      await authorizedRequest(PATH, {}, workingContext().context);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]![0]).toBe(PATH);
      expect(authorizationOf(fetchMock, 0)).toBe(`Bearer ${EXPIRED_TOKEN}`);
    });

    it("preserves the caller's method, body, and headers", async () => {
      const fetchMock = respondWith(200);

      await authorizedRequest(
        PATH,
        { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
        workingContext().context,
      );

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.body).toBe("{}");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("returns the response untouched and refreshes nothing", async () => {
      respondWith(200);
      const { refreshAccessToken, context } = workingContext();

      const response = await authorizedRequest(PATH, {}, context);

      expect(response.status).toBe(200);
      expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    // Only 401 means the token is the problem.
    it("does not refresh on a 403 or a 500", async () => {
      for (const status of [403, 500]) {
        respondWith(status);
        const { refreshAccessToken, context } = workingContext();

        const response = await authorizedRequest(PATH, {}, context);

        expect(response.status).toBe(status);
        expect(refreshAccessToken).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
      }
    });
  });

  describe("an expired access token", () => {
    it("refreshes exactly once and retries exactly once", async () => {
      const fetchMock = respondWith(401, 200);
      const { refreshAccessToken, context } = workingContext();

      const response = await authorizedRequest(PATH, {}, context);

      expect(refreshAccessToken).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(200);
    });

    it("replays with the NEW token, not the expired one", async () => {
      const fetchMock = respondWith(401, 200);

      await authorizedRequest(PATH, {}, workingContext().context);

      expect(authorizationOf(fetchMock, 0)).toBe(`Bearer ${EXPIRED_TOKEN}`);
      expect(authorizationOf(fetchMock, 1)).toBe(`Bearer ${FRESH_TOKEN}`);
    });

    it("replays the same path and the same request options", async () => {
      const fetchMock = respondWith(401, 200);

      await authorizedRequest(PATH, { method: "PATCH", body: '{"a":1}' }, workingContext().context);

      expect(fetchMock.mock.calls[1]![0]).toBe(PATH);
      const replayed = fetchMock.mock.calls[1]![1] as RequestInit;
      expect(replayed.method).toBe("PATCH");
      expect(replayed.body).toBe('{"a":1}');
    });

    // The bound that matters: a second 401 must end the exchange, not restart it.
    it("gives up after one retry when the replay is refused too", async () => {
      const fetchMock = respondWith(401, 401);
      const { refreshAccessToken, context } = workingContext();

      const response = await authorizedRequest(PATH, {}, context);

      expect(response.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(refreshAccessToken).toHaveBeenCalledOnce();
    });

    it("rejects with the refresh failure when refreshing fails", async () => {
      const fetchMock = respondWith(401);
      const failure = new Error("refresh refused");
      const context = {
        getAccessToken: () => EXPIRED_TOKEN,
        refreshAccessToken: vi.fn().mockRejectedValue(failure),
      };

      await expect(authorizedRequest(PATH, {}, context)).rejects.toBe(failure);
      // The original request was never replayed with a token that never arrived.
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe("with no access token in memory", () => {
    const anonymous = (refreshAccessToken = vi.fn().mockResolvedValue(FRESH_TOKEN)) => ({
      refreshAccessToken,
      context: { getAccessToken: () => null, refreshAccessToken },
    });

    it("sends no Authorization header", async () => {
      const fetchMock = respondWith(200);

      await authorizedRequest(PATH, {}, anonymous().context);

      expect(authorizationOf(fetchMock, 0)).toBeUndefined();
    });

    // Nothing expired if nothing was presented; the startup restore already
    // asked this question.
    it("does not refresh or retry on a 401", async () => {
      const fetchMock = respondWith(401);
      const { refreshAccessToken, context } = anonymous();

      const response = await authorizedRequest(PATH, {}, context);

      expect(response.status).toBe(401);
      expect(refreshAccessToken).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  // The refresh cookie is Path-scoped to /api/v1/auth (ADR-011 §12), so it
  // never rides along here — but the request must still be same-origin.
  it("sends same-origin credentials on both attempts", async () => {
    const fetchMock = respondWith(401, 200);

    await authorizedRequest(PATH, {}, workingContext().context);

    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe("same-origin");
    }
  });
});
