import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AuthApiError, register } from "./authApi";
import { hasSignUpErrors, validateSignUp } from "./signUpValidation";

import type { SignUpFieldErrors } from "./signUpValidation";
import type { FormEvent } from "react";

/**
 * Submission logic for the sign-up form, kept out of the JSX so the page
 * stays presentational — the same split `useLoginForm` uses.
 *
 * Registration does NOT sign anyone in. The account exists after this call
 * but cannot be used until the emailed code is redeemed, so success here
 * navigates to the verification step rather than to the dashboard. That is
 * the whole point of the flow: an address nobody controls never becomes a
 * usable account.
 */

interface UseSignUpFormOptions {
  /** Where to send the person once the account is created — the verify step. */
  verifyPath: string;
}

export interface SignUpFormState {
  name: string;
  email: string;
  password: string;
  isSubmitting: boolean;
  fieldErrors: SignUpFieldErrors;
  formError: string | null;
  setName: (value: string) => void;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const GENERIC_SIGNUP_ERROR = "Could not create your account. Please try again.";

/**
 * Maps a registration failure to what the person is told.
 *
 * `RATE_LIMITED` is named because it is the one refusal the person can act
 * on — waiting works. Everything else collapses to one message: the server
 * deliberately does not distinguish "already registered" from "created"
 * (ADR-007 §4), and a client that invented that distinction would undo the
 * protection.
 */
function signUpErrorFor(caught: unknown): string {
  if (!(caught instanceof AuthApiError)) return GENERIC_SIGNUP_ERROR;
  if (caught.status === 429) return "Too many attempts. Please wait a minute and try again.";
  if (caught.code === "NETWORK_ERROR") return caught.message;
  return GENERIC_SIGNUP_ERROR;
}

export function useSignUpForm({ verifyPath }: UseSignUpFormOptions): SignUpFormState {
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<SignUpFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmitting) return;

      const errors = validateSignUp({ name, email, password });
      setFieldErrors(errors);
      setFormError(null);
      if (hasSignUpErrors(errors)) return;

      setIsSubmitting(true);

      // Name and address are trimmed; the password never is.
      const trimmedEmail = email.trim();

      register({ name: name.trim(), email: trimmedEmail, password })
        .then(() => {
          /*
            The address travels to the verify step in the URL so the next
            form can prefill it. It is not a credential and grants nothing —
            the code is what proves control, and it is checked against
            whatever address is finally submitted.

            `replace` so Back does not return to a filled-in sign-up form
            that would create a second account on resubmit.
          */
          navigate(`${verifyPath}?email=${encodeURIComponent(trimmedEmail)}`, { replace: true });
        })
        .catch((caught: unknown) => {
          /*
            Field-level details from the server are rendered against their
            fields, which is how a rejected password length reaches the right
            input rather than the top of the form.
          */
          if (caught instanceof AuthApiError && caught.issues.length > 0) {
            const mapped: SignUpFieldErrors = {};
            for (const issue of caught.issues) {
              if (issue.field === "name" || issue.field === "email" || issue.field === "password") {
                mapped[issue.field] ??= issue.message;
              }
            }
            if (hasSignUpErrors(mapped)) {
              setFieldErrors(mapped);
              return;
            }
          }

          setFormError(signUpErrorFor(caught));
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    },
    [email, isSubmitting, name, navigate, password, verifyPath],
  );

  return {
    name,
    email,
    password,
    isSubmitting,
    fieldErrors,
    formError,
    setName,
    setEmail,
    setPassword,
    handleSubmit,
  };
}
