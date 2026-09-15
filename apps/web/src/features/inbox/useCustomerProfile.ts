import { useCallback, useEffect, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";

import {
  blockCustomer,
  fetchCustomerProfile,
  mergeCustomers,
  searchCustomers,
  unblockCustomer,
  updateCustomerDetails,
} from "./customerProfileApi";

import type { CustomerDetailsUpdate, CustomerProfile, CustomerSearchResult } from "./customerProfileApi";

/**
 * One customer's profile and the actions on it (ADR-043), for the panel
 * beside a conversation. The panel is keyed by customer id, so switching
 * conversations starts this hook fresh.
 */

export type ProfileAction = "save" | "block" | "unblock" | "merge";

function errorFor(caught: unknown): string {
  if (caught instanceof AuthApiError) {
    if (caught.code === "CUSTOMER_MERGE_CONFLICT") return "Both have an open conversation. Close one, then merge.";
    if (caught.status === 400) return caught.issues[0]?.message ?? "Check the details and try again.";
    if (caught.status === 403) return "Your role cannot do that.";
    if (caught.status === 404) return "That contact is no longer available.";
  }
  return "That did not work. Please try again.";
}

export function useCustomerProfile(organizationId: string, customerId: string) {
  const { authorizedFetch } = useAuth();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<ProfileAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCustomerProfile(authorizedFetch, organizationId, customerId).then(
      (loaded) => !cancelled && setProfile(loaded),
      (caught: unknown) => !cancelled && setLoadError(errorFor(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId, customerId]);

  const run = useCallback(async (action: ProfileAction, call: () => Promise<CustomerProfile>) => {
    setPending(action);
    setError(null);
    try {
      setProfile(await call());
      return true;
    } catch (caught) {
      if (caught instanceof AuthApiError && caught.status === 401) return false;
      setError(errorFor(caught));
      return false;
    } finally {
      setPending(null);
    }
  }, []);

  return {
    profile,
    loadError,
    pending,
    error,
    save: (update: CustomerDetailsUpdate) =>
      run("save", () => updateCustomerDetails(authorizedFetch, organizationId, customerId, update)),
    block: () => run("block", () => blockCustomer(authorizedFetch, organizationId, customerId)),
    unblock: () => run("unblock", () => unblockCustomer(authorizedFetch, organizationId, customerId)),
    merge: (sourceCustomerId: string) =>
      run("merge", () => mergeCustomers(authorizedFetch, organizationId, customerId, sourceCustomerId)),
    search: (query: string): Promise<CustomerSearchResult[]> =>
      searchCustomers(authorizedFetch, organizationId, query).then(
        (results) => results.filter((result) => result.id !== customerId),
        () => [],
      ),
  };
}
