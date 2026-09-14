import { useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";

import { inviteAgent } from "./adminApi";

interface AddAgentFormProps {
  /** Called after a successful invite, so the account list can re-read. */
  onAgentAdded: () => void;
}

/**
 * Adds a support agent (ADR-034 §7, §11).
 *
 * The only place in the product where an agent account can be created. Public
 * registration makes customers; this makes the people who answer them.
 *
 * The form collects a name and an address and nothing else — no password
 * field, because the server generates one and a password chosen here would be
 * a credential known to two people; no role, because an invited agent is an
 * agent. What the admin is told afterwards is deliberately precise about what
 * has and has not happened: the account exists, it cannot be used yet, and the
 * person must verify before the emailed password works.
 */
export function AddAgentForm({ onAgentAdded }: AddAgentFormProps) {
  const { authorizedFetch } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  const nameId = useId();
  const emailId = useId();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (trimmedName.length === 0 || trimmedEmail.length === 0) return;

    setIsSubmitting(true);
    setError(null);
    setInvited(null);

    inviteAgent(authorizedFetch, trimmedName, trimmedEmail)
      .then((agent) => {
        setInvited(agent.email);
        setName("");
        setEmail("");
        onAgentAdded();
      })
      .catch((caught: unknown) => {
        setError(inviteErrorFor(caught));
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  return (
    <section className="console__panel" aria-labelledby="console-add-agent-heading">
      <div className="console__sectionHead">
        <h2 className="console__sectionTitle" id="console-add-agent-heading">
          Add an agent
        </h2>
      </div>

      <p className="console__lede">
        They receive an email with a verification code and a temporary password. The account stays locked until they
        enter the code &mdash; the password alone will not let them in.
      </p>

      {error !== null && (
        <p className="console__alert" role="alert">
          {error}
        </p>
      )}

      {invited !== null && (
        /*
          Names the address and the next step. "Invitation sent" alone would
          leave an admin believing the agent can sign in, which is the one thing
          that is not yet true.
        */
        <p className="console__notice" role="status">
          Invitation sent to {invited}. They must enter the emailed code before they can sign in.
        </p>
      )}

      <form className="console__form" onSubmit={handleSubmit} noValidate>
        <div className="console__field">
          <label className="console__label" htmlFor={nameId}>
            Full name
          </label>
          <input
            id={nameId}
            className="console__input"
            type="text"
            autoComplete="off"
            placeholder="Alan Turing"
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
            placeholder="alan@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isSubmitting}
          />
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

/**
 * What the admin is told when an invitation fails.
 *
 * Three outcomes are worth naming because each has a different next action, and
 * everything else collapses to one message. The delivery failure is the sharp
 * one: the password exists only in that email, so an undelivered invitation
 * leaves an account nobody can ever sign into.
 */
function inviteErrorFor(caught: unknown): string {
  if (!(caught instanceof AuthApiError)) return "Could not add that agent. Please try again.";

  if (caught.code === "EMAIL_ALREADY_EXISTS") {
    return "An account already exists for that address.";
  }
  if (caught.status === 404) {
    return "No organization exists yet, so there is nothing to add an agent to.";
  }
  if (caught.status === 500) {
    return "The invitation email could not be sent, so the password never reached them. Try again.";
  }
  if (caught.issues.length > 0) {
    return caught.issues[0]!.message;
  }
  return "Could not add that agent. Please try again.";
}
