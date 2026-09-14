import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AuthApiError, homePathFor, login } from "./authApi";
import { hasFieldErrors, validateLogin } from "./loginValidation";
import { useAuth } from "./useAuth";

import type { LoginFieldErrors } from "./loginValidation";
import type { FormEvent } from "react";

/**
 * Submission logic for the sign-in form, kept out of the JSX so the page
 * component stays presentational.
 */

interface UseLoginFormOptions {
  /**
   * Where to land after a successful sign-in.
   *
   * OPTIONAL as of ADR-034 §9. Left unset, the destination is decided by the
   * account's `kind`, which login now reports: a customer goes to their chat
   * and an agent to their workspace. That is what the public `/login` page
   * wants — one address, two kinds of person, and the server saying which.
   *
   * Set explicitly by the pages that exist FOR one audience: the agent
   * sign-in page and the operations console both know where they are sending
   * somebody, and a guard on the far side re-checks that the account belongs
   * there.
   */
  redirectTo?: string;
}

export interface LoginFormState {
  email: string;
  password: string;
  rememberMe: boolean;
  isSubmitting: boolean;
  fieldErrors: LoginFieldErrors;
  /** A whole-form failure — bad credentials, unverified account, network. */
  formError: string | null;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  setRememberMe: (value: boolean) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function useLoginForm({ redirectTo }: UseLoginFormOptions = {}): LoginFormState {
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmitting) return;

      const errors = validateLogin({ email, password });
      setFieldErrors(errors);
      setFormError(null);
      if (hasFieldErrors(errors)) return;

      setIsSubmitting(true);

      // The address is trimmed; the password never is.
      login({ email: email.trim(), password })
        .then((result) => {
          signIn({ user: result.user, accessToken: result.accessToken });
          /*
            The server's answer decides, unless this page already knew. Routing
            on `kind` here rather than after a `/me` round trip is what keeps an
            agent from seeing the customer dashboard for a frame on the way to
            their inbox.
          */
          navigate(redirectTo ?? homePathFor(result.user), { replace: true });
        })
        .catch((error: unknown) => {
          if (error instanceof AuthApiError) {
            // The server's field-level detail is rendered exactly like the
            // client's own, so a rule enforced in one place looks the same
            // as one enforced in the other.
            const serverFieldErrors: LoginFieldErrors = {};
            for (const issue of error.issues) {
              if (issue.field === "email" || issue.field === "password") {
                serverFieldErrors[issue.field] = issue.message;
              }
            }
            setFieldErrors(serverFieldErrors);
            setFormError(error.message);
          } else {
            setFormError("Something went wrong. Please try again.");
          }
          setIsSubmitting(false);
        });
    },
    [email, password, isSubmitting, signIn, navigate, redirectTo],
  );

  return {
    email,
    password,
    rememberMe,
    isSubmitting,
    fieldErrors,
    formError,
    setEmail,
    setPassword,
    setRememberMe,
    handleSubmit,
  };
}
