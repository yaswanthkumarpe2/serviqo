import { callInbox } from "./inboxApi";

import type { InboxCustomer } from "./inboxApi";

/**
 * The customer profile endpoints (ADR-043). Every path names the organisation,
 * so a customer id from another organisation is a 404.
 */

type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface CustomerProfile extends InboxCustomer {
  blocked: boolean;
  profileNote: string | null;
  createdAt: string;
  lastSeenAt: string;
  blockedAt: string | null;
  blockedBy: { id: string; name: string | null } | null;
  conversations: { id: string; status: string; createdAt: string; lastMessageAt: string; tags: string[] }[];
}

export interface CustomerSearchResult extends InboxCustomer {
  blocked: boolean;
  lastSeenAt: string;
}

export type CustomerDetailsUpdate = Partial<Record<"name" | "email" | "phone" | "profileNote", string | null>>;

const base = (organizationId: string, customerId = "", suffix = "") =>
  `/api/v1/organizations/${encodeURIComponent(organizationId)}/customers${customerId ? `/${encodeURIComponent(customerId)}` : ""}${suffix}`;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});

/** Checked at the boundary, so a reply of the wrong shape shows an error rather than crashing the inbox. */
async function asProfile(pending: Promise<unknown>): Promise<CustomerProfile> {
  const data = (await pending) as Partial<CustomerProfile> | null;
  if (data === null || typeof data !== "object" || typeof data.id !== "string") {
    throw new Error("Unexpected customer profile");
  }
  return { ...data, conversations: Array.isArray(data.conversations) ? data.conversations : [] } as CustomerProfile;
}

export const fetchCustomerProfile = (authorizedFetch: AuthorizedFetch, organizationId: string, customerId: string) =>
  asProfile(callInbox<CustomerProfile>(authorizedFetch, base(organizationId, customerId)));

export const updateCustomerDetails = (
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  customerId: string,
  update: CustomerDetailsUpdate,
) => asProfile(callInbox<CustomerProfile>(authorizedFetch, base(organizationId, customerId), json("PATCH", update)));

export const blockCustomer = (authorizedFetch: AuthorizedFetch, organizationId: string, customerId: string) =>
  asProfile(callInbox<CustomerProfile>(authorizedFetch, base(organizationId, customerId, "/block"), json("POST")));

export const unblockCustomer = (authorizedFetch: AuthorizedFetch, organizationId: string, customerId: string) =>
  asProfile(callInbox<CustomerProfile>(authorizedFetch, base(organizationId, customerId, "/block"), json("DELETE")));

export const mergeCustomers = (
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  targetCustomerId: string,
  sourceCustomerId: string,
) => asProfile(callInbox<CustomerProfile>(authorizedFetch, base(organizationId, targetCustomerId, "/merge"), json("POST", { sourceCustomerId })));

export async function searchCustomers(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  query: string,
): Promise<CustomerSearchResult[]> {
  const data = await callInbox<{ customers?: unknown }>(authorizedFetch, `${base(organizationId)}?q=${encodeURIComponent(query)}`);
  return Array.isArray(data?.customers) ? (data.customers as CustomerSearchResult[]) : [];
}
