import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AuthApiError, resendVerification, verifyEmail } from "./authApi";
import { hasSignUpErrors, validateVerification } from "./signUpValidation";

import type { VerifyFieldErrors } from "./signUpValidation";
import type { FormEvent } from "react";

/**
 * Submission logic for the verification form (ADR-030).
 *
 * Two actions rather than one: redeem a code, and ask for another. The
 * second is not a convenience — a code lives ten minutes and is destroyed
 * after a few wrong guesses, so without a resend the only recovery would be
 * registering again, and the address is already taken by then.
 */

interface UseVerifyEmailFormOptions {
  /** Address to prefill, normally carried from the sign-up step. */
  initialEmail: string;
  /** Where to land once the address is verified. */
  signInPath: string;
}

export interface VerifyEmailFormState {
  email: string;
  code: string;
  isSubmitting: boolean;
  isResending: boolean;
  fieldErrors: VerifyFieldErrors;
  formError: string | null;
  /** Set after a resend, so the person knows another mail is coming. */
  notice: string | null;
  setEmail: (value: string) => void;
  setCode: (value: string) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleResend: () => void;
}

/**
 * Every redemption failure, in this client's words.
 *
 * The server answers wrong / expired / already used / too many attempts / no
 * such account with one indistinguishable `INVALID_VERIFICATION_TOKEN`, and
 * this client must not invent the distinction it withheld. So the message
 * names the two things the person can actually DO — check the digits, or get
 * a new code — rather than guessing which of five states they are in.
 */
const INVALID_CODE_MESSAGE =
  "That code did not work. It may have expired — check the digits, or send yourself a new code.";
const GENERIC_VERIFY_ERROR = "Could not verify the code. Please try again.";

function verifyErrorFor(caught: unknown): string {
  if (!(caught instanceof AuthApiError)) return GENERIC_VERIFY_ERROR;
  if (caught.code === "INVALID_VERIFICATION_TOKEN") return INVALID_CODE_MESSAGE;
  if (caught.status === 429) return "Too many attempts. Please wait a minute and try again.";
  if (caught.code === "NETWORK_ERROR") return caught.message;
  return GENERIC_VERIFY_ERROR;
}

export function useVerifyEmailForm({ initialEmail, signInPath }: UseVerifyEmailFormOptions): VerifyEmailFormState {
  const navigate = useNavigate();

  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<VerifyFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmitting) return;

      const errors = validateVerification({ email, code });
      setFieldErrors(errors);
      setFormError(null);
      setNotice(null);
      if (hasSignUpErrors(errors)) return;

      setIsSubmitting(true);

      verifyEmail({ email: email.trim(), code: code.trim() })
        .then(() => {
          /*
            Verified — but deliberately NOT signed in. Redemption proves
            control of an inbox; it is not an authentication, and the server
            issues no session for it. The person signs in with the password
            they chose, which is the credential that actually authenticates.
          */
          navigate(`${signInPath}?verified=1`, { replace: true });
        })
        .catch((caught: unknown) => {
          setFormError(verifyErrorFor(caught));
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    },
    [code, email, isSubmitting, navigate, signInPath],
  );

  const handleResend = useCallback(() => {
    if (isResending) return;

    const trimmed = email.trim();
    if (trimmed.length === 0) {
      setFieldErrors({ email: "Email is required" });
      return;
    }

    setIsResending(true);
    setFormError(null);
    setNotice(null);

    resendVerification(trimmed)
      .then(() => {
        /*
          Phrased as a conditional, because the server answers 204 whether
          the address has an account or not. Saying "a new code is on its
          way" unconditionally would confirm the address exists, which is
          precisely what the endpoint refuses to do (ADR-008 §1).
        */
        setNotice("If that address needs a code, a new one is on its way. It replaces any earlier code.");
        setCode("");
      })
      .catch((caught: unknown) => {
        setFormError(
          caught instanceof AuthApiError && caught.status === 429
            ? "Too many requests. Please wait a minute before asking for another code."
            : GENERIC_VERIFY_ERROR,
        );
      })
      .finally(() => {
        setIsResending(false);
      });
  }, [email, isResending]);

  return {
    email,
    code,
    isSubmitting,
    isResending,
    fieldErrors,
    formError,
    notice,
    setEmail,
    setCode,
    handleSubmit,
    handleResend,
  };
}
