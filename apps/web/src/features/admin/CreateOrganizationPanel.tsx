import { useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { useAuth } from "@/features/auth/useAuth";
import { OrganisationIcon } from "@/features/workspace/workspaceIcons";

import { createOrganizationWithOwner } from "./adminApi";
import { ChatLinkActions } from "./CopyLinkButton";
import { consoleWriteError } from "./consoleErrors";

import type { CreatedOrganizationResult } from "./adminApi";
import type { FormEvent } from "react";

/**
 * Creates an organisation and invites its owner, in one step (ADR-039 §1).
 *
 * The owner is required because an organisation nobody can sign into is an
 * organisation nobody can run. What comes back is the new organisation's
 * customer chat link, shown straight away because handing it out is the next
 * thing anyone does.
 */
export function CreateOrganizationPanel({ onCreated }: { onCreated: () => void }) {
  const { authorizedFetch } = useAuth();

  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOrganizationResult | null>(null);

  const nameId = useId();
  const ownerNameId = useId();
  const ownerEmailId = useId();

  const canSubmit = name.trim().length > 0 && ownerName.trim().length > 0 && ownerEmail.trim().length > 0;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || !canSubmit) return;

    setIsSubmitting(true);
    setError(null);
    setCreated(null);

    createOrganizationWithOwner(authorizedFetch, {
      name: name.trim(),
      owner: { name: ownerName.trim(), email: ownerEmail.trim() },
    })
      .then((result) => {
        setCreated(result);
        setName("");
        setOwnerName("");
        setOwnerEmail("");
        onCreated();
      })
      .catch((caught: unknown) => setError(consoleWriteError(caught, "Could not create the organisation. Try again.")))
      .finally(() => setIsSubmitting(false));
  }

  return (
    <section className="console__panel" aria-labelledby="console-create-org-heading">
      <div className="console__sectionHead">
        <h2 className="console__sectionTitle console__sectionTitle--icon" id="console-create-org-heading">
          <OrganisationIcon aria-hidden="true" />
          New organisation
        </h2>
      </div>

      <p className="console__lede">
        Its owner is emailed a temporary password and a code. Every organisation gets its own customer chat link.
      </p>

      {error !== null && (
        <p className="console__alert" role="alert">
          {error}
        </p>
      )}

      {created !== null && (
        <div className="console__notice console__notice--stack" role="status">
          <span>
            <strong>{created.organization.name}</strong> is ready.{" "}
            {created.accountCreated
              ? `${created.owner.email} has been emailed their sign-in details.`
              : `${created.owner.email} already had an account and has been added as owner.`}
          </span>
          <span className="console__linkRow">
            <span className="console__mono">{created.organization.widgetUrl}</span>
            <ChatLinkActions url={created.organization.widgetUrl} label={created.organization.name} />
          </span>
        </div>
      )}

      <form className="console__form" onSubmit={handleSubmit} noValidate>
        <div className="console__field">
          <label className="console__label" htmlFor={nameId}>
            Organisation name
          </label>
          <input
            id={nameId}
            className="console__input"
            type="text"
            autoComplete="off"
            placeholder="CentralService"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={isSubmitting}
          />
        </div>
        <div className="console__field">
          <label className="console__label" htmlFor={ownerNameId}>
            Owner&rsquo;s name
          </label>
          <input
            id={ownerNameId}
            className="console__input"
            type="text"
            autoComplete="off"
            placeholder="Olivia Owner"
            value={ownerName}
            onChange={(event) => setOwnerName(event.target.value)}
            disabled={isSubmitting}
          />
        </div>
        <div className="console__field">
          <label className="console__label" htmlFor={ownerEmailId}>
            Owner&rsquo;s email
          </label>
          <input
            id={ownerEmailId}
            className="console__input"
            type="email"
            autoComplete="off"
            placeholder="olivia@centralservice.com"
            value={ownerEmail}
            onChange={(event) => setOwnerEmail(event.target.value)}
            disabled={isSubmitting}
          />
        </div>
        <Button type="submit" variant="primary" disabled={isSubmitting || !canSubmit}>
          {isSubmitting ? "Creating…" : "Create organisation"}
        </Button>
      </form>
    </section>
  );
}
