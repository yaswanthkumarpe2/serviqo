import { useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { fetchOrganizationContext } from "./organizationsApi";

import type { CurrentUserMembership } from "@/features/auth/authApi";
import type { OrganizationContextResult } from "./organizationsApi";

import "./OrganizationSwitcher.css";

/**
 * Chooses which organization the dashboard is looking at (ADR-017 §10).
 *
 * A UX control, not a security boundary — the same thing `ProtectedRoute`
 * says about itself. Its options come from `/me`, so they are by construction
 * organizations the caller is an active member of; selecting one changes
 * which id the client puts in subsequent URLs and nothing else. The server
 * re-proves the choice on every request, and a selection the caller is not
 * entitled to comes back 404.
 *
 * The server-confirmed role is displayed rather than the one `/me` listed.
 * They agree today; showing the confirmed one means the page reflects what
 * the caller may actually do, and makes a disagreement visible instead of
 * silent.
 */

/** The server-confirmed active organization, or `null` while none is confirmed. */
export interface ActiveOrganizationContext {
  organizationId: string;
  role: string;
}

interface OrganizationSwitcherProps {
  memberships: CurrentUserMembership[];
  /**
   * Notified whenever the server-confirmed active organization changes —
   * on load, on switch, and back to `null` on a refusal (ADR-020's widget
   * installation section reads it to know which tenant it is configuring).
   *
   * A UX convenience for a sibling section to key off of, not a new source
   * of truth: it only ever carries what this component already fetched from
   * `GET /organizations/:id`, never a value chosen client-side without the
   * server's confirmation.
   */
  onActiveOrganizationChange?: (context: ActiveOrganizationContext | null) => void;
  /**
   * Bump this to make the switcher RE-READ `GET /organizations/:id`
   * (ADR-028 §16).
   *
   * The context is otherwise fetched once per organization, guarded by
   * `loadedFor` below, because nothing used to be able to change it while the
   * page was open. Ownership transfer can: the acting owner's role becomes
   * `admin` on the server, and this page would keep rendering owner-only
   * controls until a reload without a way to ask again.
   *
   * A COUNTER rather than a role passed in, deliberately. The caller says "what
   * you have is stale", never "your new role is X" — the answer still comes
   * from the server, on a fresh request, so no client-side value can become the
   * page's idea of the reader's standing.
   */
  reloadNonce?: number;
}

export function OrganizationSwitcher({
  memberships,
  onActiveOrganizationChange,
  reloadNonce = 0,
}: OrganizationSwitcherProps) {
  const { authorizedFetch } = useAuth();

  /*
    In memory only. ADR-017 §10 permits persisting the organization ID for
    convenience, and this deliberately does not: nothing about the caller's
    standing belongs in storage, and the smallest client-side footprint is the
    one that cannot drift from the server. A reload re-selects the first
    organization, which for a placeholder dashboard is a fair trade.

    Role and permissions are never stored in any form — a UI that remembered
    "I am an owner" is a UI that can be edited into one.
  */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<OrganizationContextResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defaults to the first option once `/me` settles, and corrects itself if
  // the selected organization is no longer in the list — which is what a
  // suspended tenant or a revoked membership looks like after a reload.
  const active = memberships.find((m) => m.organization.id === selectedId) ?? memberships[0] ?? null;
  const activeId = active?.organization.id ?? null;

  /** Guards against re-fetching the organization already loaded. */
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    /*
      No organization to load. The context state is deliberately not cleared
      here: with no memberships the component returns its empty state before
      the context region renders, so a stale value is unobservable — and
      clearing it would be a synchronous setState in an effect body, which
      cascades a render for no visible benefit. A ref write is not state.
    */
    if (activeId === null) {
      loadedFor.current = null;
      return;
    }
    /*
      Keyed by organization AND nonce, so a bump re-runs the fetch for the same
      organization while still collapsing StrictMode's double mount and the
      identity change a token refresh gives `authorizedFetch`.
    */
    const loadKey = `${activeId}:${reloadNonce}`;
    if (loadedFor.current === loadKey) return;
    loadedFor.current = loadKey;

    setIsLoading(true);
    setError(null);

    void fetchOrganizationContext(authorizedFetch, activeId)
      .then((result) => {
        setContext(result);
        setIsLoading(false);
      })
      .catch((caught: unknown) => {
        setContext(null);
        setIsLoading(false);

        // A 401 is a sign-out already in progress; ProtectedRoute redirects.
        if (caught instanceof AuthApiError && caught.status === 401) return;

        /*
          A 404 means the server refused this tenant — suspended, membership
          revoked, or never ours. It is deliberately indistinguishable
          (ADR-017 §6), so the message says only what is actually known.
        */
        setError(
          caught instanceof AuthApiError && caught.status === 404
            ? "That organization is no longer available to you."
            : "Could not load that organization. Please try again.",
        );
      });
  }, [activeId, authorizedFetch, reloadNonce]);

  // A separate effect from the fetch above: this one only forwards what
  // `context` already settled to, and must not itself trigger a fetch.
  useEffect(() => {
    onActiveOrganizationChange?.(
      context !== null ? { organizationId: context.organization.id, role: context.role } : null,
    );
  }, [context, onActiveOrganizationChange]);

  // Explicit empty state. A user who has onboarded nothing is the ordinary
  // case, not an error, and the create form beneath is the useful action.
  if (memberships.length === 0) {
    return (
      <section className="orgSwitcher orgSwitcher--empty card pad" aria-labelledby="org-switcher-heading">
        <h2 className="h3" id="org-switcher-heading">
          No organization yet
        </h2>
        <p className="orgSwitcher__hint">
          You do not belong to an organization. Create one below to get a workspace.
        </p>
      </section>
    );
  }

  return (
    <section className="orgSwitcher card pad" aria-labelledby="org-switcher-heading">
      <h2 className="h3" id="org-switcher-heading">
        Organization
      </h2>

      {memberships.length === 1 ? (
        // A select with one option is a control that does nothing.
        <p className="orgSwitcher__single">{active!.organization.name}</p>
      ) : (
        <>
          <label className="orgSwitcher__label" htmlFor="organization-select">
            Active organization
          </label>
          <select
            className="orgSwitcher__select"
            id="organization-select"
            value={activeId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {memberships.map((membership) => (
              <option key={membership.organization.id} value={membership.organization.id}>
                {membership.organization.name}
              </option>
            ))}
          </select>
        </>
      )}

      <div className="orgSwitcher__context" aria-busy={isLoading}>
        {isLoading ? (
          <p className="orgSwitcher__loading" role="status">
            Loading organization…
          </p>
        ) : error !== null ? (
          <p className="orgSwitcher__error" role="alert">
            {error}
          </p>
        ) : context !== null ? (
          <p className="orgSwitcher__confirmed">
            <span className="orgSwitcher__slug">/{context.organization.slug}</span>
            {/*
              The role the SERVER confirmed for this organization, not the one
              the switcher listed. This is what the caller may actually do.
            */}
            <span className="badge badge--neutral">{context.role}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
