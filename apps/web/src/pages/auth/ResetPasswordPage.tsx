import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { PASSWORD_MIN_LENGTH, VERIFICATION_CODE_LENGTH } from "@/features/auth/signUpValidation";
import { signInPathFor, useResetPasswordForm } from "@/features/auth/usePasswordResetForms";
import { cn } from "@/utils/cn";

import { EyeIcon, EyeOffIcon } from "./passwordIcons";

import "./LoginPage.css";

/**
 * Step two of password reset: redeem the code and choose a password (ADR-036).
 *
 * Reachable from step one, which carries `?email=` and `?sent=1`, and from the
 * link in the reset email, opened on whatever device the mail was read on. The
 * URL holds the address and never the code — the code is in the body of the
 * mail, for a person to retype.
 *
 * The address stays editable for `VerifyEmailPage`'s reason: somebody who
 * typed it wrong on step one must not be stranded on a form that can never
 * succeed.
 */
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const from = searchParams.get("from");
  const form = useResetPasswordForm({
    initialEmail: searchParams.get("email") ?? "",
    requested: searchParams.get("sent") === "1",
    from,
  });
  const [showPassword, setShowPassword] = useState(false);

  const emailId = useId();
  const codeId = useId();
  const passwordId = useId();
  const emailErrorId = `${emailId}-error`;
  const codeErrorId = `${codeId}-error`;
  const passwordErrorId = `${passwordId}-error`;
  const passwordHintId = `${passwordId}-hint`;
  const isAgent = from === "agent";

  return (
    <div className="auth">
      <header className="auth__bar">
        {isAgent ? (
          <span className="brand">
            <span className="brand__mark" aria-hidden="true">
              <BrandMark />
            </span>
            Serviqo
          </span>
        ) : (
          <>
            <Link className="brand" to="/">
              <span className="brand__mark" aria-hidden="true">
                <BrandMark />
              </span>
              Serviqo
            </Link>
            <Link className="auth__back" to="/">
              Back to site
            </Link>
          </>
        )}
      </header>

      <main className="auth__main">
        <div className="auth__card card">
          <div className="auth__head">
            <h1 className="auth__title">Choose a new password</h1>
            <p className="auth__lede">
              Enter the {VERIFICATION_CODE_LENGTH}-digit code from your email. It expires in a few minutes.
            </p>
          </div>

          {form.formError !== null && (
            <div className="auth__alert" role="alert">
              {form.formError}
            </div>
          )}

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
                Reset code
              </label>
              <input
                id={codeId}
                className={cn("field__input", "field__input--code", form.fieldErrors.code && "field__input--invalid")}
                // Text with a numeric keypad, not type="number": see VerifyEmailPage.
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

            <div className="field">
              <label className="field__label" htmlFor={passwordId}>
                New password
              </label>
              <div className="field__control">
                <input
                  id={passwordId}
                  className={cn(
                    "field__input",
                    "field__input--withAction",
                    form.fieldErrors.newPassword && "field__input--invalid",
                  )}
                  type={showPassword ? "text" : "password"}
                  name="newPassword"
                  // Lets a password manager offer to generate one and to
                  // update the entry it already holds for this address.
                  autoComplete="new-password"
                  value={form.newPassword}
                  onChange={(event) => form.setNewPassword(event.target.value)}
                  aria-invalid={form.fieldErrors.newPassword !== undefined}
                  aria-describedby={form.fieldErrors.newPassword ? passwordErrorId : passwordHintId}
                  disabled={form.isSubmitting}
                />
                <button
                  className="field__action"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  disabled={form.isSubmitting}
                >
                  {showPassword ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                </button>
              </div>
              {form.fieldErrors.newPassword ? (
                <p className="field__error" id={passwordErrorId}>
                  {form.fieldErrors.newPassword}
                </p>
              ) : (
                <p className="field__hint" id={passwordHintId}>
                  At least {PASSWORD_MIN_LENGTH} characters. You&rsquo;ll be signed out everywhere you&rsquo;re signed in.
                </p>
              )}
            </div>

            <Button type="submit" variant="primary" className="auth__submit" disabled={form.isSubmitting}>
              {form.isSubmitting ? (
                <>
                  <span className="auth__spinner" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Reset password"
              )}
            </Button>
          </form>

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
            Remembered it? <Link to={signInPathFor(from)}>Sign in</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
