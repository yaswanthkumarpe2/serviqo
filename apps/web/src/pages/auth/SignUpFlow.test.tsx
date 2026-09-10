import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { SignUpPage } from "@/pages/auth/SignUpPage";
import { VerifyEmailPage } from "@/pages/auth/VerifyEmailPage";

/**
 * Registration and verification as one journey (ADR-007, ADR-030).
 *
 * Tested together rather than as two isolated pages, because the thing most
 * likely to break is not either form — it is the handoff between them. The
 * address has to survive the navigation, the account has to be unusable
 * until the code is redeemed, and a failed code has to leave the person
 * somewhere they can recover from rather than at a dead end.
 *
 * The assertions that matter most here are the ones that are easy to get
 * wrong and invisible when broken: that a wrong code does not reveal WHICH
 * of five failure states occurred, and that a resend cannot be phrased in a
 * way that confirms an address exists.
 */

const EMAIL = "ada@example.com";
/** Obvious sentinel — if it reaches the DOM as readable text, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD_1";

const unauthenticatedRefresh = {
  success: false,
  error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid or expired" },
};

interface Outcome {
  status: number;
  body: unknown;
}

const REGISTERED: Outcome = {
  status: 201,
  body: { success: true, data: { user: { id: "u1", name: "Ada Lovelace", email: EMAIL } } },
};

/** 204 with no body — what verify and resend actually answer. */
const NO_CONTENT: Outcome = { status: 204, body: null };

const EMAIL_TAKEN: Outcome = {
  status: 409,
  body: {
    success: false,
    error: { code: "EMAIL_ALREADY_EXISTS", message: "An account with this email address already exists" },
  },
};

const INVALID_CODE: Outcome = {
  status: 400,
  body: {
    success: false,
    error: { code: "INVALID_VERIFICATION_TOKEN", message: "Verification code could not be redeemed" },
  },
};

/**
 * Routes auth calls by path, refusing the provider's startup refresh.
 *
 * `AuthProvider` asks the refresh endpoint on mount whether this browser has
 * a session. These tests are about someone who does not, so it is refused —
 * and answered separately so assertions about registration never read the
 * restore's call by mistake.
 */
function stubAuth(outcomes: { register?: Outcome; verify?: Outcome; resend?: Outcome } = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).split("?")[0]!;

    if (path.endsWith("/auth/refresh")) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(unauthenticatedRefresh) } as Response);
    }

    const pick = path.endsWith("/auth/register")
      ? (outcomes.register ?? REGISTERED)
      : path.endsWith("/auth/verify-email")
        ? (outcomes.verify ?? NO_CONTENT)
        : path.endsWith("/auth/resend-verification")
          ? (outcomes.resend ?? NO_CONTENT)
          : null;

    if (pick === null) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) } as Response);
    }

    void init;
    return Promise.resolve({
      ok: pick.status >= 200 && pick.status < 300,
      status: pick.status,
      // A real 204 has no body; `.json()` on one rejects.
      json: () => (pick.body === null ? Promise.reject(new Error("no body")) : Promise.resolve(pick.body)),
    } as Response);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Renders both pages behind a router so the handoff between them is real. */
function renderFlow(initialPath = "/signup") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/signup" element={<SignUpPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/login" element={<h1>Sign in to Serviqo</h1>} />
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign-up", () => {
  it("refuses an empty form without calling the server", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Name is required")).toBeDefined();
    expect(screen.getByText("Email is required")).toBeDefined();
    expect(screen.getByText("Password is required")).toBeDefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/auth/register"))).toBe(false);
  });

  /*
    The policy is stated before submission here, unlike the sign-in form
    which deliberately never names it. At registration the person is
    CHOOSING the password, so a hidden rule is one they cannot comply with.
  */
  it("states the length policy rather than making the server reject it", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow();

    expect(screen.getByText("At least 10 characters.")).toBeDefined();

    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Password must be at least 10 characters")).toBeDefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/auth/register"))).toBe(false);
  });

  it("registers and carries the address to the verification step", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow();

    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), `  ${EMAIL}  `);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeDefined();
    // Prefilled, so the person types six digits rather than digits plus an address.
    expect(screen.getByLabelText("Email")).toHaveProperty("value", EMAIL);

    const sent = bodyOf(fetchMock, "/auth/register");
    expect(sent?.email).toBe(EMAIL);
    // Trimmed on the address; never on the password.
    expect(sent?.password).toBe(PASSWORD);
  });

  /*
    Registration must NOT sign anyone in. The account exists after this call
    and is deliberately unusable until the code is redeemed — landing on the
    dashboard here would mean an address nobody controls had become a
    working account.
  */
  it("does not sign the new account in", async () => {
    stubAuth();
    const user = userEvent.setup();
    renderFlow();

    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await screen.findByRole("heading", { name: "Check your email" });
    expect(screen.queryByText(/dashboard/i)).toBeNull();
  });

  /*
    Registration DOES disclose that an address is taken, deliberately
    (ADR-007 §1) — a generic answer would only close enumeration if the
    existing address were also emailed a notice, turning the endpoint into
    an email-sending oracle. That decision has to be surfaced, not hidden,
    and ADR-007 anticipates precisely this pairing: someone holding an
    account they never verified, whose retry returns 409.
  */
  it("offers both ways out when the address is already taken", async () => {
    stubAuth({ register: EMAIL_TAKEN });
    const user = userEvent.setup();
    renderFlow();

    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(EMAIL);
    // "Try again" is useless here: retrying can never succeed.
    expect(alert.textContent).not.toContain("try again");

    /*
      Scoped to the alert: the page footer carries its own "Sign in" link, and
      an unscoped query would pass on that one even if the alert offered
      nothing at all.
    */
    const routes = within(alert);
    expect(routes.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(routes.getByRole("link", { name: "finish verifying it" }).getAttribute("href")).toBe(
      `/verify-email?email=${encodeURIComponent(EMAIL)}`,
    );
  });

  it("keeps the password out of the DOM", async () => {
    stubAuth();
    const user = userEvent.setup();
    const { container } = renderFlow();

    await user.type(screen.getByLabelText("Password"), PASSWORD);

    // Present as an input VALUE, never as rendered text.
    expect(container.textContent).not.toContain(PASSWORD);
  });
});

describe("verification", () => {
  const VERIFY_PATH = `/verify-email?email=${encodeURIComponent(EMAIL)}`;

  it("refuses a short code without spending a server attempt", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow(VERIFY_PATH);

    await user.type(screen.getByLabelText("Verification code"), "123");
    await user.click(screen.getByRole("button", { name: "Verify email" }));

    /*
      Not cosmetic: the server destroys a code after a small number of WRONG
      attempts, so a typo that reached it would cost one of them. A fumbling
      user would lock themselves out faster than an attacker.
    */
    expect(await screen.findByText("The code is 6 digits")).toBeDefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/auth/verify-email"))).toBe(false);
  });

  it("strips non-digits as they are typed", async () => {
    stubAuth();
    const user = userEvent.setup();
    renderFlow(VERIFY_PATH);

    const field = screen.getByLabelText("Verification code");
    await user.type(field, "12ab34cd");

    expect(field).toHaveProperty("value", "1234");
  });

  it("verifies and sends the person to sign in", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow(VERIFY_PATH);

    await user.type(screen.getByLabelText("Verification code"), "246810");
    await user.click(screen.getByRole("button", { name: "Verify email" }));

    expect(await screen.findByRole("heading", { name: "Sign in to Serviqo" })).toBeDefined();

    // Both halves travel: a code identifies nothing on its own.
    const sent = bodyOf(fetchMock, "/auth/verify-email");
    expect(sent).toEqual({ email: EMAIL, code: "246810" });
  });

  /*
    The server answers wrong / expired / already used / too many attempts /
    no such account with one indistinguishable refusal, and this client must
    not invent the distinction it withheld. The message names what the
    person can DO instead of guessing which state they are in.
  */
  it("gives one recoverable message for every refusal", async () => {
    stubAuth({ verify: INVALID_CODE });
    const user = userEvent.setup();
    renderFlow(VERIFY_PATH);

    await user.type(screen.getByLabelText("Verification code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify email" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("did not work");
    expect(alert.textContent).toContain("new code");
    // Never names which failure it was.
    expect(alert.textContent).not.toContain("expired code");
    expect(alert.textContent).not.toContain("attempts");
    expect(alert.textContent).not.toContain("account");
    // Still on the page, with a way forward.
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeDefined();
  });

  it("asks for a replacement code", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow(VERIFY_PATH);

    await user.type(screen.getByLabelText("Verification code"), "111111");
    await user.click(screen.getByRole("button", { name: "Send a new code" }));

    const notice = await screen.findByRole("status");
    /*
      Conditional phrasing, because the endpoint answers 204 whether the
      address has an account or not. "A new code is on its way" stated
      flatly would confirm the address exists, which is exactly what the
      endpoint refuses to do.
    */
    expect(notice.textContent).toContain("If that address needs a code");
    expect(bodyOf(fetchMock, "/auth/resend-verification")).toEqual({ email: EMAIL });
    // The old code is dead, so the field is cleared rather than left to mislead.
    expect(screen.getByLabelText("Verification code")).toHaveProperty("value", "");
  });

  /*
    Someone who mistyped their address at sign-up would otherwise be stranded
    on a page that can never succeed, with no route back that does not create
    a second account.
  */
  it("lets the address be corrected", async () => {
    const fetchMock = stubAuth();
    const user = userEvent.setup();
    renderFlow(VERIFY_PATH);

    const emailField = screen.getByLabelText("Email");
    await user.clear(emailField);
    await user.type(emailField, "corrected@example.com");
    await user.type(screen.getByLabelText("Verification code"), "246810");
    await user.click(screen.getByRole("button", { name: "Verify email" }));

    await waitFor(() => {
      expect(bodyOf(fetchMock, "/auth/verify-email")?.email).toBe("corrected@example.com");
    });
  });

  it("works when opened cold, with no address in the URL", async () => {
    stubAuth();
    renderFlow("/verify-email");

    // Reached from an emailed link on another device: the form still works,
    // it just asks for the address too.
    expect(screen.getByLabelText("Email")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Verify email" })).toBeDefined();
  });
});
