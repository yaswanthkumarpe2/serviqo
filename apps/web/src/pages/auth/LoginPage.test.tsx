import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { LoginPage } from "@/pages/auth/LoginPage";

const EMAIL = "ada@example.com";
/** Obvious sentinel — if it reaches the DOM as readable text unexpectedly, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

const successBody = {
  success: true,
  data: {
    user: { id: "u1", name: "Ada Lovelace", email: EMAIL },
    accessToken: "header.payload.signature",
    expiresIn: 900,
  },
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Renders the page inside a router that reveals where a successful sign-in lands. */
function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<h1>Dashboard reached</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const emailField = () => screen.getByLabelText("Email");
const passwordField = () => screen.getByLabelText("Password");
const submitButton = () => screen.getByRole("button", { name: /^sign in$/i });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  describe("rendering", () => {
    it("shows the fields the sign-in flow needs", () => {
      renderLogin();

      expect(emailField()).toBeDefined();
      expect(passwordField()).toBeDefined();
      expect(screen.getByRole("checkbox", { name: /remember me/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /forgot password/i })).toBeDefined();
      expect(submitButton()).toBeDefined();
    });

    it("masks the password until the reveal is pressed", async () => {
      const user = userEvent.setup();
      renderLogin();

      expect(passwordField()).toHaveProperty("type", "password");

      await user.click(screen.getByRole("button", { name: "Show password" }));
      expect(passwordField()).toHaveProperty("type", "text");

      await user.click(screen.getByRole("button", { name: "Hide password" }));
      expect(passwordField()).toHaveProperty("type", "password");
    });
  });

  describe("client-side validation", () => {
    it("reports both empty fields and sends no request", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch(200, successBody);
      renderLogin();

      await user.click(submitButton());

      expect(screen.getByText("Email is required")).toBeDefined();
      expect(screen.getByText("Password is required")).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a malformed address before the network", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch(200, successBody);
      renderLogin();

      await user.type(emailField(), "not-an-address");
      await user.type(passwordField(), PASSWORD);
      await user.click(submitButton());

      expect(screen.getByText("Enter a valid email address")).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("marks the invalid field for assistive technology", async () => {
      const user = userEvent.setup();
      stubFetch(200, successBody);
      renderLogin();

      await user.click(submitButton());

      expect(emailField().getAttribute("aria-invalid")).toBe("true");
    });
  });

  describe("successful sign-in", () => {
    it("submits the trimmed address and the untouched password", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch(200, successBody);
      renderLogin();

      await user.type(emailField(), `  ${EMAIL}  `);
      await user.type(passwordField(), PASSWORD);
      await user.click(submitButton());

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ email: EMAIL, password: PASSWORD });
    });

    it("lands on the dashboard", async () => {
      const user = userEvent.setup();
      stubFetch(200, successBody);
      renderLogin();

      await user.type(emailField(), EMAIL);
      await user.type(passwordField(), PASSWORD);
      await user.click(submitButton());

      expect(await screen.findByText("Dashboard reached")).toBeDefined();
    });

    it("shows a loading state and blocks a second submit", async () => {
      const user = userEvent.setup();
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const fetchMock = vi.fn().mockReturnValue(
        pending.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(successBody) }) as unknown as Response),
      );
      vi.stubGlobal("fetch", fetchMock);
      renderLogin();

      await user.type(emailField(), EMAIL);
      await user.type(passwordField(), PASSWORD);
      await user.click(submitButton());

      const submitting = await screen.findByRole("button", { name: /signing in/i });
      expect(submitting).toHaveProperty("disabled", true);

      await user.click(submitting);
      expect(fetchMock).toHaveBeenCalledOnce();

      release(undefined);
      expect(await screen.findByText("Dashboard reached")).toBeDefined();
    });
  });

  describe("server-reported failures", () => {
    it("shows the message for invalid credentials and stays on the page", async () => {
      const user = userEvent.setup();
      stubFetch(401, {
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" },
      });
      renderLogin();

      await user.type(emailField(), EMAIL);
      await user.type(passwordField(), "wrong-password");
      await user.click(submitButton());

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("Email or password is incorrect");
      expect(screen.queryByText("Dashboard reached")).toBeNull();
    });

    it("shows the unverified-account message", async () => {
      const user = userEvent.setup();
      stubFetch(403, {
        success: false,
        error: { code: "EMAIL_NOT_VERIFIED", message: "Verify your email address before signing in" },
      });
      renderLogin();

      await user.type(emailField(), EMAIL);
      await user.type(passwordField(), PASSWORD);
      await user.click(submitButton());

      expect((await screen.findByRole("alert")).textContent).toBe("Verify your email address before signing in");
    });

    it("attaches server field detail to the field it names", async () => {
      const user = userEvent.setup();
      stubFetch(400, {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: [{ field: "email", message: "Email must be a valid email address" }],
        },
      });
      renderLogin();

      await user.type(emailField(), EMAIL);
      await user.type(passwordField(), PASSWORD);
      await user.click(submitButton());

      expect(await screen.findByText("Email must be a valid email address")).toBeDefined();
    });

    it("re-enables the form so the attempt can be retried", async () => {
      const user = userEvent.setup();
      stubFetch(401, { success: false, error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } });
      renderLogin();

      await user.type(emailField(), EMAIL);
      await user.type(passwordField(), "wrong-password");
      await user.click(submitButton());

      await screen.findByRole("alert");
      expect(submitButton()).toHaveProperty("disabled", false);
    });

    it("reports a transport failure in the caller's terms", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      renderLogin();

      await user.type(emailField(), EMAIL);
      await user.type(passwordField(), PASSWORD);
      await user.click(submitButton());

      expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach the server/i);
    });
  });
});
