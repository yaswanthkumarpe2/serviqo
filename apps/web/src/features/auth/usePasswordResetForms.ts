import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AuthApiError, requestPasswordReset, resetPassword } from "./authApi";
import { hasSignUpErrors, validateForgotPassword, validateResetPassword } from "./signUpValidation";

import type { ResetPasswordFieldErrors } from "./signUpValidation";
import type { FormEvent } from "react";

/**
 * Submission logic for the two password-reset forms (ADR-036).
 *
 * Two hooks in one file because they are one journey: ask for a code, then
 * redeem it. They share the "which sign-in page did you come from" question
 * and the rule that nothing either form says may confirm an address exists.
 */

/**
 * Which door a person returns to once their password is reset.
 *
 * Carried as `?from=agent` rather than inferred, because the reset endpoints
 * are deliberately silent about the account — this page cannot ask the server
 * whether an address belongs to an agent, and should not be able to. Anything
 * other than the one known value means the customer door, so a hand-edited URL
 * can at worst send somebody to the general sign-in page, which routes an
 * agent onward anyway (ADR-034 §9).
 */
export function signInPathFor(from: string | null): string {
  return from === "agent" ? "/agent/login" : "/login";
}

/** Keeps the `from` marker on a link between the two pages. */
export function withFrom(path: string, from: string | null): string {
  if (from !== "agent") return path;
  return `${path}${path.includes("?") ? "&" : "?"}from=agent`;
}

const TOO_MANY = "Too many requests. Please wait a few minutes and try again.";
const GENERIC_FAILURE = "Something went wrong. Please try again.";

function requestErrorFor(caught: unknown): string {
  if (!(caught instanceof AuthApiError)) return GENERIC_FAILURE;
  if (caught.status === 429) return TOO_MANY;
  if (caught.code === "NETWORK_ERROR") return caught.message;
  return GENERIC_FAILURE;
}

// ---- step one: ask for a code ----

export interface ForgotPasswordFormState {
  email: string;
  isSubmitting: boolean;
  fieldError: string | null;
  formError: string | null;
  setEmail: (value: string) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function useForgotPasswordForm({ initialEmail, from }: { initialEmail: string; from: string | null }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState(initialEmail);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmitting) return;

      const errors = validateForgotPassword({ email });
      setFieldError(errors.email ?? null);
      setFormError(null);
      if (errors.email !== undefined) return;

      const trimmed = email.trim();
      setIsSubmitting(true);

      requestPasswordReset(trimmed)
        .then(() => {
          /*
            On to the code form whatever the server found, because it tells us
            nothing — the next page's wording carries the "if" that honesty
            requires. `sent=1` is what lets that page say a mail was requested
            rather than greeting the person with a blank form.
          */
          const params = new URLSearchParams({ email: trimmed, sent: "1" });
          navigate(withFrom(`/reset-password?${params.toString()}`, from));
        })
        .catch((caught: unknown) => {
          setFormError(requestErrorFor(caught));
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    },
    [email, from, isSubmitting, navigate],
  );

  return { email, isSubmitting, fieldError, formError, setEmail, handleSubmit } satisfies ForgotPasswordFormState;
}

// ---- step two: redeem it ----

export interface ResetPasswordFormState {
  email: string;
  code: string;
  newPassword: string;
  isSubmitting: boolean;
  isResending: boolean;
  fieldErrors: ResetPasswordFieldErrors;
  formError: string | null;
  notice: string | null;
  setEmail: (value: string) => void;
  setCode: (value: string) => void;
  setNewPassword: (value: string) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleResend: () => void;
}

/**
 * Every refusal about the code, in this client's words.
 *
 * Wrong, expired, used, destroyed by too many guesses, or an address with no
 * account: the server withholds which, and so must this. The message names
 * what the person can do instead.
 */
const INVALID_CODE_MESSAGE =
  "That code did not work. It may have expired — check the digits, or send yourself a new code.";

export function useResetPasswordForm({
  initialEmail,
  requested,
  from,
}: {
  initialEmail: string;
  /** True when the person arrived straight from asking for a code. */
  requested: boolean;
  from: string | null;
}): ResetPasswordFormState {
  const navigate = useNavigate();

  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ResetPasswordFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  /*
    Conditional, for resend-verification's reason (ADR-008 §1): the request
    answered 204 whether or not the address has an account.
  */
  const [notice, setNotice] = useState<string | null>(
    requested ? "If that address has an account, we've emailed it a code." : null,
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmitting) return;

      const errors = validateResetPassword({ email, code, newPassword });
      setFieldErrors(errors);
      setFormError(null);
      setNotice(null);
      if (hasSignUpErrors(errors)) return;

      setIsSubmitting(true);

      resetPassword({ email: email.trim(), code: code.trim(), newPassword })
        .then(() => {
          /*
            Not signed in: a reset proves the inbox, and the server issues no
            session for it (ADR-036 §4). The person signs in with the password
            they just chose, which is also the moment they find out they typed
            it the way they meant to.
          */
          navigate(`${signInPathFor(from)}?reset=1`, { replace: true });
        })
        .catch((caught: unknown) => {
          if (caught instanceof AuthApiError && caught.code === "INVALID_PASSWORD_RESET_CODE") {
            setFormError(INVALID_CODE_MESSAGE);
            return;
          }
          // The server's own field messages, e.g. a password it measured
          // differently from this client (it counts code points after NFC).
          if (caught instanceof AuthApiError && caught.code === "VALIDATION_ERROR" && caught.issues.length > 0) {
            const next: ResetPasswordFieldErrors = {};
            for (const issue of caught.issues) {
              if (issue.field === "email" || issue.field === "code" || issue.field === "newPassword") {
                next[issue.field] = issue.message;
              }
            }
            setFieldErrors(next);
            if (Object.keys(next).length > 0) return;
          }
          setFormError(requestErrorFor(caught));
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    },
    [code, email, from, isSubmitting, navigate, newPassword],
  );

  const handleResend = useCallback(() => {
    if (isResending) return;

    const errors = validateForgotPassword({ email });
    if (errors.email !== undefined) {
      setFieldErrors({ email: errors.email });
      return;
    }

    setIsResending(true);
    setFormError(null);
    setNotice(null);

    requestPasswordReset(email.trim())
      .then(() => {
        setNotice("If that address has an account, a new code is on its way. It replaces any earlier code.");
        setCode("");
      })
      .catch((caught: unknown) => {
        setFormError(requestErrorFor(caught));
      })
      .finally(() => {
        setIsResending(false);
      });
  }, [email, isResending]);

  return {
    email,
    code,
    newPassword,
    isSubmitting,
    isResending,
    fieldErrors,
    formError,
    notice,
    setEmail,
    setCode,
    setNewPassword,
    handleSubmit,
    handleResend,
  };
}
