import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { DashboardPage } from "@/pages/dashboard/DashboardPage";
import { ProtectedRoute } from "@/routes/ProtectedRoute";

import type { Session } from "@/features/auth/AuthContext";

const session: Session = {
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  accessToken: "header.payload.signature",
};

function renderDashboard(initialSession: Session | null) {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AuthProvider initialSession={initialSession}>
        <Routes>
          <Route path="/login" element={<h1>Sign-in page</h1>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("ProtectedRoute", () => {
  it("sends an unauthenticated visitor to the sign-in page", () => {
    renderDashboard(null);

    expect(screen.getByText("Sign-in page")).toBeDefined();
    expect(screen.queryByText(/welcome/i)).toBeNull();
  });

  it("renders the protected page when a session exists", () => {
    renderDashboard(session);

    expect(screen.getByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
  });
});

describe("DashboardPage", () => {
  it("shows the signed-in user's name and email", () => {
    renderDashboard(session);

    expect(screen.getByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
    expect(screen.getByText("ada@example.com")).toBeDefined();
  });

  it("shows the three placeholder metrics", () => {
    renderDashboard(session);

    expect(screen.getByText("Total conversations")).toBeDefined();
    expect(screen.getByText("Open tickets")).toBeDefined();
    expect(screen.getByText("Waiting customers")).toBeDefined();
  });

  // CONTRIBUTING.md: demo data must be labelled as demo data, never left to
  // read as a working feature.
  it("labels the metrics as sample data", () => {
    renderDashboard(session);

    expect(screen.getByText("SAMPLE DATA")).toBeDefined();
    expect(screen.getByText(/these figures are placeholders/i)).toBeDefined();
  });

  it("never renders the access token", () => {
    const { container } = renderDashboard(session);

    expect(container.textContent).not.toContain(session.accessToken);
  });

  it("signing out clears the session and returns to the sign-in page", async () => {
    const user = userEvent.setup();
    renderDashboard(session);

    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.getByText("Sign-in page")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
  });
});
