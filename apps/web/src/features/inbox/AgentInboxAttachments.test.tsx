import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";

import { AgentInbox } from "./AgentInbox";
import { splitLinks } from "./linkify";
import { createFakeInboxSocketHarness } from "./testing/fakeInboxSocket";

import type { Session } from "@/features/auth/AuthContext";

/**
 * Files, emoji and links in the agent inbox (ADR-041 §6).
 */

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: "SEEDED_ACCESS_TOKEN",
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const ROW = {
  id: "c1",
  status: "open",
  createdAt: "2026-09-14T09:00:00.000Z",
  lastMessageAt: "2026-09-14T10:00:00.000Z",
  customer: { id: "cust-1", name: "Grace", email: null },
  assignedTo: null,
};

const PHOTO = {
  id: "a1",
  name: "damaged box.jpg",
  contentType: "image/jpeg",
  size: 51200,
  url: "/api/v1/files/a1/damaged%20box.jpg?key=KEY",
};
const PDF = { id: "a2", name: "invoice.pdf", contentType: "application/pdf", size: 1536, url: "/api/v1/files/a2/invoice.pdf?key=KEY" };

const HISTORY = [
  {
    id: "m1",
    conversationId: "c1",
    senderType: "customer",
    body: "It arrived like this, see https://shop.example/orders/42",
    attachments: [PHOTO],
    createdAt: "2026-09-14T09:00:00.000Z",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const base = stubAuthFetch();
  fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url).split("?")[0]!;
    if (/\/c1\/attachments$/.test(path)) return Promise.resolve(jsonResponse(201, { success: true, data: PDF }));
    if (/\/c1\/messages$/.test(path) && init?.method === "POST") {
      const sent = JSON.parse(init.body as string);
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          data: { id: "m2", conversationId: "c1", senderType: "agent", body: sent.body, attachments: [PDF], createdAt: "2026-09-14T10:01:00.000Z" },
        }),
      );
    }
    if (/\/c1\/messages$/.test(path)) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { messages: HISTORY, nextCursor: null } }));
    }
    if (/\/conversations$/.test(path)) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { conversations: [ROW], nextCursor: null } }));
    }
    return base(url, init) as Promise<Response>;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openGrace() {
  const harness = createFakeInboxSocketHarness();
  render(
    <AuthProvider initialSession={session}>
      <AgentInbox key="org-acme" organizationId="org-acme" socketFactory={harness.factory} />
    </AuthProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Grace/ }));
  await screen.findByText(/It arrived like this/);
  return user;
}

describe("AgentInbox attachments", () => {
  it("shows a customer's picture and makes their link clickable", async () => {
    await openGrace();

    const image = screen.getByRole("img", { name: "damaged box.jpg" });
    expect(image.getAttribute("src")).toBe(PHOTO.url);

    const link = screen.getByRole("link", { name: "https://shop.example/orders/42" });
    expect(link.getAttribute("href")).toBe("https://shop.example/orders/42");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("uploads a file, sends it with the reply, and shows it as a download", async () => {
    const user = await openGrace();

    const file = new File(["%PDF-1.4"], "invoice.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/Reply to this conversation/).closest("form")!.querySelector('input[type="file"]') as HTMLInputElement, file);

    const tray = await screen.findByRole("list", { name: "Files to send" });
    await waitFor(() => expect(within(tray).queryByText("Uploading…")).toBeNull());

    const upload = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/c1/attachments"))!;
    expect((upload[1] as RequestInit).headers).toMatchObject({ "Content-Type": "application/pdf", "X-Filename": "invoice.pdf" });

    await user.type(screen.getByLabelText(/Reply to this conversation/), "Here is your invoice");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const send = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/c1/messages") && (init as RequestInit | undefined)?.method === "POST",
    )!;
    expect(JSON.parse((send[1] as RequestInit).body as string)).toEqual({ body: "Here is your invoice", attachmentIds: ["a2"] });

    const download = await screen.findByRole("link", { name: /invoice\.pdf/ });
    expect(download.getAttribute("download")).toBe("invoice.pdf");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Files to send" })).toBeNull());
  });

  it("refuses a file type the server would refuse", async () => {
    const user = userEvent.setup({ applyAccept: false });
    await openGrace();

    const input = screen.getByLabelText(/Reply to this conversation/).closest("form")!.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["<html>"], "page.html", { type: "text/html" }));

    expect(await screen.findByText("Only images, PDFs and text files can be sent.")).toBeDefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/attachments"))).toBe(false);
  });

  it("inserts an emoji into the reply", async () => {
    const user = await openGrace();

    await user.type(screen.getByLabelText(/Reply to this conversation/), "Sorted ");
    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    await user.click(screen.getByRole("button", { name: "Insert 👍" }));

    expect((screen.getByLabelText(/Reply to this conversation/) as HTMLTextAreaElement).value).toBe("Sorted 👍");
  });

  it("splits links exactly as the widget does", () => {
    expect(splitLinks("go to www.a.example.")).toEqual([
      { type: "text", value: "go to " },
      { type: "link", value: "www.a.example", href: "https://www.a.example/" },
      { type: "text", value: "." },
    ]);
    expect(splitLinks("javascript:alert(1)")).toEqual([{ type: "text", value: "javascript:alert(1)" }]);
  });
});
