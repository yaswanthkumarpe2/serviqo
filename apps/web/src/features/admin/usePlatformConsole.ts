import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";

import { fetchPlatformOrganizations, fetchPlatformOverview, fetchPlatformUsers } from "./adminApi";

import type { PlatformOrganizationSummary, PlatformOverview, PlatformUserSummary } from "./adminApi";

/**
 * Everything the operations console reads, in one load (ADR-032 §12).
 *
 * Three endpoints rather than one, fetched together rather than in sequence.
 * They are independent reads and the console shows all three at once, so
 * waiting for the totals before asking for the tenant list would add a round
 * trip to every page load for no benefit.
 *
 * They are also allowed to fail INDEPENDENTLY. A console whose tenant list
 * failed should still show the totals it did get — an operator opening this
 * page is usually looking at something already broken, and the least useful
 * response to a partial failure is a blank screen.
 */

export interface PlatformConsoleState {
  overview: PlatformOverview | null;
  organizations: PlatformOrganizationSummary[];
  organizationTotal: number;
  users: PlatformUserSummary[];
  userTotal: number;
  /** True until the first load settles. Nothing real is known before it does. */
  isLoading: boolean;
  /** True while a manual refresh is in flight, with the previous answer still on screen. */
  isRefreshing: boolean;
  /**
   * A failure that is not an authentication problem. A 401 is deliberately
   * absent: it is not a message to show, it is a sign-out.
   */
  error: string | null;
  /** When this data was read, so a console left open does not silently go stale. */
  loadedAt: Date | null;
  refresh: () => void;
}

const GENERIC_FAILURE_MESSAGE = "Could not load the platform console. Please try again.";
const FORBIDDEN_MESSAGE = "This account no longer holds platform access.";

export function usePlatformConsole(): PlatformConsoleState {
  const { authorizedFetch, signOut } = useAuth();

  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [organizations, setOrganizations] = useState<PlatformOrganizationSummary[]>([]);
  const [organizationTotal, setOrganizationTotal] = useState(0);
  const [users, setUsers] = useState<PlatformUserSummary[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  /**
   * Guards against a refresh landing after a later one.
   *
   * Two clicks of Refresh are two in-flight request sets, and they can settle
   * out of order. Only the newest is allowed to write state, so the console
   * cannot end up showing an older answer than the one it already had.
   */
  const loadId = useRef(0);

  const load = useCallback(
    async (isInitial: boolean) => {
      const id = loadId.current + 1;
      loadId.current = id;

      if (isInitial) setIsLoading(true);
      else setIsRefreshing(true);

      /*
        `allSettled` rather than `all`, which is the independence described
        above: `all` rejects on the first failure and discards the two answers
        that succeeded.
      */
      const [overviewResult, organizationsResult, usersResult] = await Promise.allSettled([
        fetchPlatformOverview(authorizedFetch),
        fetchPlatformOrganizations(authorizedFetch),
        fetchPlatformUsers(authorizedFetch),
      ]);

      if (loadId.current !== id) return;

      const failures = [overviewResult, organizationsResult, usersResult].filter(
        (result) => result.status === "rejected",
      );

      /*
        A 401 here has already been through `authorizedRequest`'s one refresh
        and one replay. Surviving that means the credential cannot be
        recovered, so this browser is not signed in — signing out is the
        correct response and the one that reaches the login page, because
        `PlatformAdminRoute` redirects on the next render. No imperative
        navigation from inside a data hook.
      */
      if (failures.some((result) => result.reason instanceof AuthApiError && result.reason.status === 401)) {
        void signOut();
        return;
      }

      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
      if (organizationsResult.status === "fulfilled") {
        setOrganizations(organizationsResult.value.organizations);
        setOrganizationTotal(organizationsResult.value.total);
      }
      if (usersResult.status === "fulfilled") {
        setUsers(usersResult.value.users);
        setUserTotal(usersResult.value.total);
      }

      /*
        A 403 is its own message. It means the grant was revoked while this
        console was open, which is exactly the case ADR-032 §4's per-request
        database read exists to produce — and "please try again" would be
        false, because trying again cannot work.
      */
      const forbidden = failures.some(
        (result) => result.reason instanceof AuthApiError && result.reason.status === 403,
      );

      setError(forbidden ? FORBIDDEN_MESSAGE : failures.length > 0 ? GENERIC_FAILURE_MESSAGE : null);
      setLoadedAt(new Date());
      setIsLoading(false);
      setIsRefreshing(false);
    },
    [authorizedFetch, signOut],
  );

  /**
   * Guards the one load per mount, the same way `useCurrentUser` does.
   *
   * StrictMode mounts, unmounts and remounts in development, and this
   * effect's dependency is a provider callback whose identity changes when
   * the session does — which a refresh inside this very call would cause.
   */
  const hasLoaded = useRef(false);

  useEffect(() => {
    if (hasLoaded.current) return;
    hasLoaded.current = true;
    void load(true);
  }, [load]);

  const refresh = useCallback(() => {
    void load(false);
  }, [load]);

  return {
    overview,
    organizations,
    organizationTotal,
    users,
    userTotal,
    isLoading,
    isRefreshing,
    error,
    loadedAt,
    refresh,
  };
}
