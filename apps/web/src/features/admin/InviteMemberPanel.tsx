import { useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { useAuth } from "@/features/auth/useAuth";
import { HeadsetIcon } from "@/features/workspace/workspaceIcons";

import { inviteOrganizationMember } from "./adminApi";
import { consoleWriteError } from "./consoleErrors";

import type { InvitableRole } from "./adminApi";
import type { FormEvent } from "react";

const ROLES: { value: InvitableRole; label: string }[] = [
  { value: "agent", label: "Agent" },
  { value: "supervisor", label: "Supervisor" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner (only if it has none)" },
];

/**
 * Invites someone into one organisation from the console (ADR-039 §3).
 *
 * Unlike the organisation's own Team page, this can name an owner — the
 * repair for an organisation whose owner left, or was never invited.
 */
export function InviteMemberPanel({
  organizationId,
  organizationName,
  onInvited,
}: {
  organizationId: string;
  organizationName: string;
  onInvited: () => void;
}) {
  const { authorizedFetch } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("agent");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const nameId = useId();
  const emailId = useId();
  const roleId = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || name.trim().length === 0 || email.trim().length === 0) return;

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    inviteOrganizationMember(authorizedFetch, organizationId, { name: name.trim(), email: email.trim(), role })
      .then(({ member, accountCreated }) => {
        setNotice(
          accountCreated
            ? `${member.email} has been emailed a temporary password and a code for ${organizationName}.`
            : `${member.email} already had an account and has been added to ${organizationName}.`,
        );
        setName("");
        setEmail("");
        onInvited();
      })
      .catch((caught: unknown) => setError(consoleWriteError(caught, "Could not send the invitation. Try again.")))
      .finally(() => setIsSubmitting(false));
  }

  return (
    <section className="console__panel" aria-labelledby={`${nameId}-heading`}>
      <h3 className="console__sectionTitle console__sectionTitle--icon" id={`${nameId}-heading`}>
        <HeadsetIcon aria-hidden="true" />
        Invite someone to {organizationName}
      </h3>

      {error !== null && (
        <p className="console__alert" role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="console__notice" role="status">
          {notice}
        </p>
      )}

      <form className="console__form" onSubmit={handleSubmit} noValidate>
        <div className="console__field">
          <label className="console__label" htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            className="console__input"
            type="text"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={isSubmitting}
          />
        </div>
        <div className="console__field">
          <label className="console__label" htmlFor={emailId}>
            Email
          </label>
          <input
            id={emailId}
            className="console__input"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isSubmitting}
          />
        </div>
        <div className="console__field console__field--narrow">
          <label className="console__label" htmlFor={roleId}>
            Role
          </label>
          <select
            id={roleId}
            className="console__input"
            value={role}
            onChange={(event) => setRole(event.target.value as InvitableRole)}
            disabled={isSubmitting}
          >
            {ROLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={isSubmitting || name.trim().length === 0 || email.trim().length === 0}
        >
          {isSubmitting ? "Sending…" : "Send invitation"}
        </Button>
      </form>
    </section>
  );
}
