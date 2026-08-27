import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { createOrganization } from "./organizationsApi";

import type { CreateOrganizationResult } from "./organizationsApi";
import type { FormEvent } from "react";

import "./CreateOrganizationForm.css";

/**
 * Creates the caller's organization (ADR-016 §10).
 *
 * Deliberately the whole of this slice's frontend. It does NOT list the
 * caller's organizations, offer a switcher, or gate anything on membership:
 * `/me` still returns no organization, and a client-side notion of "my
 * organizations" built before the server has one is exactly the fake state
 * Slice 16 removed from this page.
 *
 * What it shows after a success is only what the server just returned —
 * including the slug, which is the part the user did not choose and would
 * otherwise have no way to learn.
 */

const NAME_MAX_LENGTH = 100;

export function CreateOrganizationForm() {
  const { authorizedFetch } = useAuth();
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [created, setCreated] = useState<CreateOrganizationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // The server validates this too; the guard only stops a request that
    // cannot succeed (ADR-007 §6 — the boundary is the authority).
    if (trimmed.length === 0 || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      setCreated(await createOrganization(authorizedFetch, trimmed));
      setName("");
    } catch (caught) {
      /*
        A 401 is not shown. `authorizedFetch` has already refreshed once and
        replayed once; surviving that means the provider cleared the session,
        and `ProtectedRoute` is about to redirect — an error message would
        flash and vanish.
      */
      if (caught instanceof AuthApiError && caught.status === 401) return;

      setError(
        caught instanceof AuthApiError
          ? caught.message
          : "Could not create the organization. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="orgForm card pad" aria-labelledby="create-org-heading">
      <h2 className="h3" id="create-org-heading">
        Create an organization
      </h2>
      <p className="orgForm__hint">
        Your organization is the workspace your team and your customers&rsquo; conversations belong to. You become its
        owner.
      </p>

      <form className="orgForm__form" onSubmit={handleSubmit} noValidate>
        <label className="orgForm__label" htmlFor="organization-name">
          Organization name
        </label>
        <div className="orgForm__row">
          <input
            className="orgForm__input"
            id="organization-name"
            name="organizationName"
            type="text"
            value={name}
            maxLength={NAME_MAX_LENGTH}
            placeholder="Acme Corp"
            autoComplete="organization"
            disabled={isSubmitting}
            onChange={(event) => setName(event.target.value)}
            aria-describedby={error === null ? undefined : "create-org-error"}
            aria-invalid={error !== null}
          />
          <Button type="submit" size="sm" disabled={isSubmitting || trimmed.length === 0}>
            {isSubmitting ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>

      {error !== null && (
        <p className="orgForm__error" id="create-org-error" role="alert">
          {error}
        </p>
      )}

      {/*
        Announced rather than merely rendered: the form does not navigate, so
        without `role="status"` a screen-reader user gets no signal that
        anything happened.
      */}
      {created !== null && (
        <div className="orgForm__created" role="status">
          <p className="orgForm__createdName">{created.organization.name}</p>
          <p className="orgForm__createdMeta">
            <span className="orgForm__slug">/{created.organization.slug}</span>
            <span className="badge badge--neutral">{created.role}</span>
          </p>
        </div>
      )}
    </section>
  );
}
