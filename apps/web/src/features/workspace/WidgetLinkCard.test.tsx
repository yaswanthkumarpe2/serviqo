import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WidgetLinkCard } from "./WidgetLinkCard";

/** The customer chat link, as staff see it (ADR-038 §4). */

const URL = "https://serviqo.com/widget/centralservice";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WidgetLinkCard", () => {
  it("shows the link exactly as the server built it", () => {
    render(<WidgetLinkCard widgetUrl={URL} />);

    expect(screen.getByRole("region", { name: "Customer chat link" })).toBeDefined();
    expect((screen.getByLabelText("Link to share") as HTMLInputElement).value).toBe(URL);
    expect(screen.getByRole("link", { name: /open/i }).getAttribute("href")).toBe(URL);
  });

  it("opens the link in a new tab without handing it this page", () => {
    render(<WidgetLinkCard widgetUrl={URL} />);

    const open = screen.getByRole("link", { name: /open/i });
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
  });

  it("copies the link and says so", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<WidgetLinkCard widgetUrl={URL} />);

    await user.click(screen.getByRole("button", { name: /copy link/i }));

    expect(writeText).toHaveBeenCalledWith(URL);
    expect(await screen.findByRole("button", { name: /copied/i })).toBeDefined();
    expect(screen.getByRole("status").textContent).toMatch(/copied/i);
  });

  it("stays usable when the clipboard is refused", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<WidgetLinkCard widgetUrl={URL} />);

    await user.click(screen.getByRole("button", { name: /copy link/i }));

    expect(screen.getByRole("button", { name: /copy link/i })).toBeDefined();
    expect((screen.getByLabelText("Link to share") as HTMLInputElement).value).toBe(URL);
  });
});
