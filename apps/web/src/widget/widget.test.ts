import { afterEach, describe, expect, it, vi } from "vitest";

import { initWidget } from "./widget";

import type { WidgetConfig } from "./types";

const CONFIG: WidgetConfig = { widgetKey: "wk_test", apiBase: "https://dashboard.example.com/api/v1/widget" };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const READY_BODY = {
  success: true,
  data: { token: "TOKEN_1", expiresInSeconds: 86400, customer: { id: "c1", name: null, email: null } },
};

function shadowOf(host: Element): ShadowRoot {
  const shadow = host.shadowRoot;
  if (shadow === null) throw new Error("expected a shadow root");
  return shadow;
}

function findHost(): HTMLElement | null {
  return document.querySelector("[data-serviqo-widget-host]");
}

afterEach(() => {
  findHost()?.remove();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("initWidget", () => {
  it("mounts one host element into document.body with an open shadow root", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY)));

    initWidget(CONFIG);

    const host = findHost();
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(document.body);
    expect(host!.shadowRoot).not.toBeNull();
    expect(host!.shadowRoot!.mode).toBe("open");
  });

  it("returns null and mounts nothing when Shadow DOM is unsupported", () => {
    const original = Element.prototype.attachShadow;
    // @ts-expect-error -- deliberately simulating an old browser for this one test
    delete Element.prototype.attachShadow;

    const handle = initWidget(CONFIG);

    expect(handle).toBeNull();
    expect(findHost()).toBeNull();

    Element.prototype.attachShadow = original;
  });

  it("renders an accessible, closed launcher and does not call the session endpoint yet", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY));
    vi.stubGlobal("fetch", fetchMock);

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;

    expect(launcher.getAttribute("aria-label")).toBe("Open chat");
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(shadow.querySelector(".panel")!.hasAttribute("hidden")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the panel, shows loading, then opens the session lazily on first open", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY));
    vi.stubGlobal("fetch", fetchMock);

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;

    launcher.click();

    expect(shadow.querySelector(".panel")!.hasAttribute("hidden")).toBe(false);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(shadow.querySelector('[role="status"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.waitFor(() => {
      expect(shadow.querySelector("h3")!.textContent).toBe("How can we help?");
    });
    expect(shadow.querySelector(".state p")!.textContent).toBe(
      "Chat is ready. Our support team is ready to assist you.",
    );
  });

  it("does not re-open a session on a second open once one is already ready", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY));
    vi.stubGlobal("fetch", fetchMock);

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;

    launcher.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    launcher.click(); // close
    launcher.click(); // reopen

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows an error state and offers a retry that calls the session endpoint again", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({ success: false, error: { code: "WIDGET_SESSION_REFUSED", message: "This chat widget is not available." } }) } as Response);
    vi.stubGlobal("fetch", fetchMock);

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;
    launcher.click();

    await vi.waitFor(() => {
      expect(shadow.querySelector('[role="alert"]')).not.toBeNull();
    });
    // The server's specific refusal reason never reaches the widget's UI (ADR-019 §12).
    expect(shadow.querySelector(".error p")!.textContent).not.toContain("WIDGET_SESSION_REFUSED");

    fetchMock.mockResolvedValueOnce(jsonResponse(201, READY_BODY));
    (shadow.querySelector(".retry") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(shadow.querySelector("h3")!.textContent).toBe("How can we help?");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape and returns focus to the launcher", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY)));

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;
    launcher.click();
    expect(shadow.querySelector(".panel")!.hasAttribute("hidden")).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(shadow.querySelector(".panel")!.hasAttribute("hidden")).toBe(true);
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(shadow.activeElement).toBe(launcher);
  });

  it("closes on the panel's own close button", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY)));

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    (shadow.querySelector(".launcher") as HTMLButtonElement).click();
    (shadow.querySelector(".panel__close") as HTMLButtonElement).click();

    expect(shadow.querySelector(".panel")!.hasAttribute("hidden")).toBe(true);
  });

  it("stores the issued token under sessionStorage, namespaced by widget key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY)));

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    (shadow.querySelector(".launcher") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(window.sessionStorage.getItem(`serviqo_widget_token::${CONFIG.widgetKey}`)).toBe("TOKEN_1");
    });
  });

  it("never writes the token to the console", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY)));

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    (shadow.querySelector(".launcher") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(window.sessionStorage.getItem(`serviqo_widget_token::${CONFIG.widgetKey}`)).toBe("TOKEN_1"));

    const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(" ");
    expect(allOutput).not.toContain("TOKEN_1");

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("offers an optional name/email form once ready, and resumes the same session on submit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY));
    vi.stubGlobal("fetch", fetchMock);

    initWidget(CONFIG);
    const shadow = shadowOf(findHost()!);
    (shadow.querySelector(".launcher") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(shadow.querySelector("form")).not.toBeNull());

    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: { token: "TOKEN_2", expiresInSeconds: 86400, customer: { id: "c1", name: "Ada", email: null } },
      }),
    );

    const nameInput = shadow.querySelector("#serviqo-widget-name") as HTMLInputElement;
    nameInput.value = "Ada";
    nameInput.dispatchEvent(new Event("input"));
    (shadow.querySelector("form") as HTMLFormElement).requestSubmit();

    await vi.waitFor(() => {
      expect(shadow.querySelector(".thanks")).not.toBeNull();
    });
    expect(shadow.querySelector(".thanks")!.textContent).toContain("Ada");

    const [, secondCallInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(secondCallInit.body as string)).toMatchObject({ visitorToken: "TOKEN_1", name: "Ada" });
  });

  it("destroy() removes the host from the document and stops listening for Escape", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, READY_BODY)));

    const handle = initWidget(CONFIG)!;
    expect(findHost()).not.toBeNull();

    handle.destroy();

    expect(findHost()).toBeNull();
    // Dispatching Escape after destroy must not throw despite no panel existing.
    expect(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))).not.toThrow();
  });
});
