import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { PASSWORD_MIN_LENGTH, VERIFICATION_CODE_LENGTH } from "@/features/auth/signUpValidation";
import { useSignUpForm } from "@/features/auth/useSignUpForm";
import { cn } from "@/utils/cn";

import { EyeIcon, EyeOffIcon } from "./passwordIcons";

import "./LoginPage.css";

/**
 * Account creation (ADR-007, ADR-030).
 *
 * Presentational only — submission, validation and navigation live in
 * `useSignUpForm`, the same split `LoginPage` uses, and the styles are
 * shared with it rather than duplicated.
 *
 * This form does not create a usable account. It creates an unverified one
 * and sends a six-digit code; the account cannot sign in until that code is
 * redeemed on the next page. The copy says so up front, because a person who
 * believes they have finished will close the tab and never verify.
 */
export function SignUpPage() {
  const form = useSignUpForm({ verifyPath: "/verify-email" });
  const [showPassword, setShowPassword] = useState(false);

  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const nameErrorId = `${nameId}-error`;
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;
  const passwordHintId = `${passwordId}-hint`;

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
            <h1 className="auth__title">Create your Serviqo account</h1>
            <p className="auth__lede">
              We&rsquo;ll email you a {VERIFICATION_CODE_LENGTH}-digit code to confirm your address before you can sign in.
            </p>
          </div>

          {/*
            A taken address is a fork, not a failure to retry. Both routes
            out of it are offered, because which one is right depends on
            something this page cannot know: whether that account was ever
            verified. Someone who never redeemed their code needs the second
            link, and telling them only to sign in would send them to a form
            that refuses them.
          */}
          {form.existingAccountEmail !== null && (
            <div className="auth__alert" role="alert">
              An account already exists for {form.existingAccountEmail}.{" "}
              <Link to="/login">Sign in</Link>, or{" "}
              <Link to={`/verify-email?email=${encodeURIComponent(form.existingAccountEmail)}`}>
                finish verifying it
              </Link>
              .
            </div>
          )}

          {form.formError !== null && (
            <div className="auth__alert" role="alert">
              {form.formError}
            </div>
          )}

          <form className="auth__form" onSubmit={form.handleSubmit} noValidate>
            <div className="field">
              <label className="field__label" htmlFor={nameId}>
                Name
              </label>
              <input
                id={nameId}
                className={cn("field__input", form.fieldErrors.name && "field__input--invalid")}
                type="text"
                name="name"
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={form.name}
                onChange={(event) => form.setName(event.target.value)}
                aria-invalid={form.fieldErrors.name !== undefined}
                aria-describedby={form.fieldErrors.name ? nameErrorId : undefined}
                disabled={form.isSubmitting}
              />
              {form.fieldErrors.name && (
                <p className="field__error" id={nameErrorId}>
                  {form.fieldErrors.name}
                </p>
              )}
            </div>

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
              <label className="field__label" htmlFor={passwordId}>
                Password
              </label>
              <div className="field__control">
                <input
                  id={passwordId}
                  className={cn(
                    "field__input",
                    "field__input--withAction",
                    form.fieldErrors.password && "field__input--invalid",
                  )}
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete="new-password"
                  placeholder="Choose a password"
                  value={form.password}
                  onChange={(event) => form.setPassword(event.target.value)}
                  aria-invalid={form.fieldErrors.password !== undefined}
                  aria-describedby={form.fieldErrors.password ? passwordErrorId : passwordHintId}
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
              {form.fieldErrors.password ? (
                <p className="field__error" id={passwordErrorId}>
                  {form.fieldErrors.password}
                </p>
              ) : (
                /*
                  Stated before submission, unlike the sign-in form which
                  deliberately never names the policy. Here the person is
                  CHOOSING the password, so a hidden rule is one they cannot
                  comply with — they would only learn it by being rejected.
                */
                <p className="field__hint" id={passwordHintId}>
                  At least {PASSWORD_MIN_LENGTH} characters.
                </p>
              )}
            </div>

            <Button type="submit" variant="primary" className="auth__submit" disabled={form.isSubmitting}>
              {form.isSubmitting ? (
                <>
                  <span className="auth__spinner" aria-hidden="true" />
                  Creating account…
                </>
              ) : (
                "Create account"
              )}
            </Button>
          </form>

          <p className="auth__foot">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
