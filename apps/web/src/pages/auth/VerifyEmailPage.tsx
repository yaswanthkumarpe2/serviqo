import { useId } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { VERIFICATION_CODE_LENGTH } from "@/features/auth/signUpValidation";
import { useVerifyEmailForm } from "@/features/auth/useVerifyEmailForm";
import { cn } from "@/utils/cn";

import "./LoginPage.css";

/**
 * Redeeming the six-digit code that completes registration (ADR-030).
 *
 * Reachable two ways, and both must work. From the sign-up form, which
 * arrives with `?email=` and only needs the digits; and from the emailed
 * link, opened on a different device from the one that registered, where
 * the address is prefilled the same way. Neither carries a secret — the
 * code is in the body of the mail, for a person to read and retype, so this
 * URL is safe in a history, a referrer header, or a screenshot.
 *
 * The address stays editable rather than being locked to the query
 * parameter. Someone who mistyped it at sign-up would otherwise be stuck on
 * a page that can never succeed, with no way back that does not create a
 * second account.
 */
export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const form = useVerifyEmailForm({
    initialEmail: searchParams.get("email") ?? "",
    signInPath: "/login",
  });

  const emailId = useId();
  const codeId = useId();
  const emailErrorId = `${emailId}-error`;
  const codeErrorId = `${codeId}-error`;

  return (
    <div className="auth">
      <header className="auth__bar">
        <Link className="brand" to="/">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark />
          </span>
          Serviqo
        </Link>
        <Link className="auth__back" to="/">
          Back to site
        </Link>
      </header>

      <main className="auth__main">
        <div className="auth__card card">
          <div className="auth__head">
            <h1 className="auth__title">Check your email</h1>
            <p className="auth__lede">
              Enter the {VERIFICATION_CODE_LENGTH}-digit code we sent you. It expires in a few minutes.
            </p>
          </div>

          {form.formError !== null && (
            <div className="auth__alert" role="alert">
              {form.formError}
            </div>
          )}

          {/*
            role="status" rather than "alert": a resend confirmation is
            information, not a problem, and should not interrupt a screen
            reader mid-sentence the way an error should.
          */}
          {form.notice !== null && (
            <div className="auth__notice" role="status">
              {form.notice}
            </div>
          )}

          <form className="auth__form" onSubmit={form.handleSubmit} noValidate>
            <div className="field">
              <label className="field__label" htmlFor={emailId}>
                Email
              </label>
              <input
                id={emailId}
                className={cn("field__input", form.fieldErrors.email && "field__input--invalid")}
                type="email"
                name="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={form.email}
                onChange={(event) => form.setEmail(event.target.value)}
                aria-invalid={form.fieldErrors.email !== undefined}
                aria-describedby={form.fieldErrors.email ? emailErrorId : undefined}
                disabled={form.isSubmitting}
              />
              {form.fieldErrors.email && (
                <p className="field__error" id={emailErrorId}>
                  {form.fieldErrors.email}
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor={codeId}>
                Verification code
              </label>
              <input
                id={codeId}
                className={cn("field__input", "field__input--code", form.fieldErrors.code && "field__input--invalid")}
                /*
                  `inputMode="numeric"` gives a phone the number pad without
                  `type="number"`, which would strip leading zeros and offer
                  a spinner — and a code beginning with zero is legitimate.
                  `autoComplete="one-time-code"` lets iOS and Android offer
                  the code straight from the notification.
                */
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                name="code"
                placeholder="000000"
                maxLength={VERIFICATION_CODE_LENGTH}
                value={form.code}
                onChange={(event) => form.setCode(event.target.value.replace(/\D/g, ""))}
                aria-invalid={form.fieldErrors.code !== undefined}
                aria-describedby={form.fieldErrors.code ? codeErrorId : undefined}
                disabled={form.isSubmitting}
              />
              {form.fieldErrors.code && (
                <p className="field__error" id={codeErrorId}>
                  {form.fieldErrors.code}
                </p>
              )}
            </div>

            <Button type="submit" variant="primary" className="auth__submit" disabled={form.isSubmitting}>
              {form.isSubmitting ? (
                <>
                  <span className="auth__spinner" aria-hidden="true" />
                  Verifying…
                </>
              ) : (
                "Verify email"
              )}
            </Button>
          </form>

          {/*
            Not optional politeness: a code lives minutes and dies after a
            few wrong guesses, so without this the only recovery is to
            register again — and the address is already taken by then.
          */}
          <p className="auth__foot">
            Didn&rsquo;t get it?{" "}
            <button
              type="button"
              className="auth__linkButton"
              onClick={form.handleResend}
              disabled={form.isResending || form.isSubmitting}
            >
              {form.isResending ? "Sending…" : "Send a new code"}
            </button>
          </p>

          <p className="auth__foot">
            Already verified? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
