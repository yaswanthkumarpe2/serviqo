import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { ForgotPasswordPage } from "@/pages/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";

/**
 * Password reset as one journey (ADR-036).
 *
 * Tested across both pages for the reason the sign-up flow is: the likeliest
 * break is the handoff — the address and the door the person came from have to
 * survive the navigation — and the wording has to stay conditional, because the
 * server never says whether an address has an account.
 */

const EMAIL = "ada@example.com";
/** Obvious sentinel — if it reaches the DOM as readable text, the test fails. */
const NEW_PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD_2";

interface Outcome {
  status: number;
  body: unknown;
}

const NO_CONTENT: Outcome = { status: 204, body: null };

const INVALID_CODE: Outcome = {
  status: 400,
  body: {
    success: false,
    error: { code: "INVALID_PASSWORD_RESET_CODE", message: "Password reset code could not be redeemed" },
  },
};

const RATE_LIMITED: Outcome = {
  status: 429,
  body: { success: false, error: { code: "TOO_MANY_REQUESTS", message: "Too many requests." } },
};

function stubAuth(outcomes: { forgot?: Outcome; reset?: Outcome } = {}) {
  const fetchMock = vi.fn((url: string) => {
    const path = String(url).split("?")[0]!;

    if (path.endsWith("/auth/refresh")) {
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ success: false, error: { code: "INVALID_REFRESH_TOKEN", message: "no" } }),
      } as Response);
    }

    const pick = path.endsWith("/auth/forgot-password")
      ? (outcomes.forgot ?? NO_CONTENT)
      : path.endsWith("/auth/reset-password")
        ? (outcomes.reset ?? NO_CONTENT)
        : null;

    if (pick === null) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) } as Response);
    }

    return Promise.resolve({
      ok: pick.status >= 200 && pick.status < 300,
      status: pick.status,
      json: () => (pick.body === null ? Promise.reject(new Error("no body")) : Promise.resolve(pick.body)),
    } as Response);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Shows where the flow ended up, including the query string. */
function Landed({ label }: { label: string }) {
  const location = useLocation();
  return (
    <h1>
      {label} {location.search}
    </h1>
  );
}

function renderFlow(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<Landed label="Customer sign-in" />} />
          <Route path="/agent/login" element={<Landed label="Agent sign-in" />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, suffix: string): Record<string, unknown> | null {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith(suffix));
  const init = call?.[1] as RequestInit | undefined;
  return typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
}

const calledPath = (fetchMock: ReturnType<typeof vi.fn>, suffix: string) =>
  fetchMock.mock.calls.some(([url]) => String(url).endsWith(suffix));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("asking for a code", () => {
  it("refuses an empty address without calling the server", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow("/forgot-password");

    await user.click(await screen.findByRole("button", { name: "Send code" }));

    expect(await screen.findByText("Email is required")).toBeDefined();
    expect(calledPath(fetchMock, "/auth/forgot-password")).toBe(false);
  });

  it("sends the address and moves on to the code form, carrying it along", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow("/forgot-password");

    await user.type(await screen.findByLabelText("Email"), EMAIL);
    await user.click(screen.getByRole("button", { name: "Send code" }));

    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeDefined();
    expect(bodyOf(fetchMock, "/auth/forgot-password")).toEqual({ email: EMAIL });
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(EMAIL);
  });

  it("says a code was sent only IF the address has an account", async () => {
    stubAuth();
    const user = userEvent.setup();
    renderFlow("/forgot-password");

    await user.type(await screen.findByLabelText("Email"), EMAIL);
    await user.click(screen.getByRole("button", { name: "Send code" }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/if that address has an account/i);
  });

  it("explains a rate-limit refusal rather than moving on", async () => {
    stubAuth({ forgot: RATE_LIMITED });
    const user = userEvent.setup();
    renderFlow("/forgot-password");

    await user.type(await screen.findByLabelText("Email"), EMAIL);
    await user.click(screen.getByRole("button", { name: "Send code" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/too many requests/i);
    expect(screen.queryByRole("heading", { name: "Choose a new password" })).toBeNull();
  });
});

describe("redeeming the code", () => {
  async function fillReset(user: ReturnType<typeof userEvent.setup>, code = "481920", password = NEW_PASSWORD) {
    await user.type(await screen.findByLabelText("Reset code"), code);
    await user.type(screen.getByLabelText("New password"), password);
    await user.click(screen.getByRole("button", { name: "Reset password" }));
  }

  it("prefills the address from the emailed link", async () => {
    stubAuth();
    renderFlow(`/reset-password?email=${encodeURIComponent(EMAIL)}`);

    expect(((await screen.findByLabelText("Email")) as HTMLInputElement).value).toBe(EMAIL);
    // Arriving from the email, not from step one, so nothing claims a mail was just sent.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("sends address, code and password, then lands on the customer sign-in with a notice flag", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow(`/reset-password?email=${encodeURIComponent(EMAIL)}`);

    await fillReset(user);

    expect(await screen.findByRole("heading", { name: /Customer sign-in \?reset=1/ })).toBeDefined();
    expect(bodyOf(fetchMock, "/auth/reset-password")).toEqual({
      email: EMAIL,
      code: "481920",
      newPassword: NEW_PASSWORD,
    });
  });

  it("returns an agent to the agent door", async () => {
    stubAuth();
    const user = userEvent.setup();
    renderFlow(`/reset-password?from=agent&email=${encodeURIComponent(EMAIL)}`);

    await fillReset(user);

    expect(await screen.findByRole("heading", { name: /Agent sign-in \?reset=1/ })).toBeDefined();
  });

  it("carries the agent door through step one as well", async () => {
    stubAuth();
    const user = userEvent.setup();
    renderFlow("/forgot-password?from=agent");

    await user.type(await screen.findByLabelText("Email"), EMAIL);
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await fillReset(user);

    expect(await screen.findByRole("heading", { name: /Agent sign-in/ })).toBeDefined();
  });

  it("refuses a short password and a short code without calling the server", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow(`/reset-password?email=${encodeURIComponent(EMAIL)}`);

    await fillReset(user, "123", "short");

    expect(await screen.findByText("The code is 6 digits")).toBeDefined();
    expect(screen.getByText(/at least 10 characters/i)).toBeDefined();
    expect(calledPath(fetchMock, "/auth/reset-password")).toBe(false);
  });

  it("words a refused code without guessing why, and stays on the page", async () => {
    stubAuth({ reset: INVALID_CODE });
    const user = userEvent.setup();
    renderFlow(`/reset-password?email=${encodeURIComponent(EMAIL)}`);

    await fillReset(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/did not work/i);
    expect(alert.textContent).not.toMatch(/no account|not found|locked/i);
    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeDefined();
  });

  it("asks for a new code with conditional wording, and clears the old digits", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow(`/reset-password?email=${encodeURIComponent(EMAIL)}`);

    await user.type(await screen.findByLabelText("Reset code"), "111111");
    await user.click(screen.getByRole("button", { name: "Send a new code" }));

    await waitFor(() => expect(calledPath(fetchMock, "/auth/forgot-password")).toBe(true));
    expect((await screen.findByRole("status")).textContent).toMatch(/if that address has an account/i);
    expect((screen.getByLabelText("Reset code") as HTMLInputElement).value).toBe("");
  });

  it("never renders the new password as readable text", async () => {
    stubAuth({ reset: INVALID_CODE });
    const user = userEvent.setup();
    const { container } = renderFlow(`/reset-password?email=${encodeURIComponent(EMAIL)}`);

    await fillReset(user);
    await screen.findByRole("alert");

    expect(container.textContent).not.toContain(NEW_PASSWORD);
    expect((screen.getByLabelText("New password") as HTMLInputElement).type).toBe("password");
  });
});
