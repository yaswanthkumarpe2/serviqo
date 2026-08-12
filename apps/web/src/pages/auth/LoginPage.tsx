import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { useLoginForm } from "@/features/auth/useLoginForm";
import { cn } from "@/utils/cn";

import { EyeIcon, EyeOffIcon } from "./passwordIcons";

import "./LoginPage.css";

/**
 * Organization-user sign-in (ADR-010: customers never sign in anywhere).
 *
 * Presentational only — submission, validation and navigation live in
 * `useLoginForm`.
 */
export function LoginPage() {
  const form = useLoginForm({ redirectTo: "/dashboard" });
  const [showPassword, setShowPassword] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;

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
            <h1 className="auth__title">Sign in to Serviqo</h1>
            <p className="auth__lede">Use your organization account to reach your workspace.</p>
          </div>

          {/*
            role="alert" so a failure is announced the moment it appears —
            a sighted user sees it, and a screen-reader user is told.
          */}
          {form.formError !== null && (
            <div className="auth__alert" role="alert">
              {form.formError}
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
              <div className="field__labelRow">
                <label className="field__label" htmlFor={passwordId}>
                  Password
                </label>
                {/*
                  Placeholder until the password-reset slice exists. It is a
                  button, not a link to nowhere, so it cannot advertise a
                  route that would 404.
                */}
                <button
                  className="auth__forgot"
                  type="button"
                  onClick={() => undefined}
                  title="Password reset is not available yet"
                >
                  Forgot password?
                </button>
              </div>
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
                  autoComplete="current-password"
                  placeholder="Your password"
                  value={form.password}
                  onChange={(event) => form.setPassword(event.target.value)}
                  aria-invalid={form.fieldErrors.password !== undefined}
                  aria-describedby={form.fieldErrors.password ? passwordErrorId : undefined}
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
              {form.fieldErrors.password && (
                <p className="field__error" id={passwordErrorId}>
                  {form.fieldErrors.password}
                </p>
              )}
            </div>

            {/*
              Remember me is presentation only in this slice. Session
              lifetime is fixed server-side by SESSION_TTL_MS, and honouring
              this box would mean changing how a credential is issued — a
              backend decision, not a checkbox.
            */}
            <label className="auth__remember">
              <input
                type="checkbox"
                checked={form.rememberMe}
                onChange={(event) => form.setRememberMe(event.target.checked)}
                disabled={form.isSubmitting}
              />
              <span>Remember me</span>
            </label>

            <Button type="submit" variant="primary" className="auth__submit" disabled={form.isSubmitting}>
              {form.isSubmitting ? (
                <>
                  <span className="auth__spinner" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          <p className="auth__foot">
            No account yet? <span className="auth__footMuted">Ask your organization owner for an invitation.</span>
          </p>
        </div>
      </main>
    </div>
  );
}
