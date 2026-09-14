import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { useLoginForm } from "@/features/auth/useLoginForm";
import { cn } from "@/utils/cn";

import { EyeIcon, EyeOffIcon } from "./passwordIcons";

import "./LoginPage.css";

/**
 * The staff sign-in page (ADR-037).
 *
 * For the people who ANSWER chats: agents and organisation admins, and the
 * super admin if they arrive here rather than at the console's own door.
 * Customers never sign in — they reach an organisation through its chat link —
 * so there is no sign-up link, and the lede says where a customer should go
 * instead of leaving them to wonder why they cannot make an account.
 *
 * `/agent/login` renders this same page. It used to be a separate agent door
 * beside a customer one (ADR-034 §9); with no customer door there is nothing
 * to separate.
 *
 * Presentational only — submission, validation and navigation live in
 * `useLoginForm`.
 */
export function LoginPage() {
  /*
    No fixed destination: the server reports which kind of staff account this
    is, and `useLoginForm` routes on it — the workspace for an agent, the
    console for the super admin.
  */
  const form = useLoginForm();
  const [showPassword, setShowPassword] = useState(false);
  const [searchParams] = useSearchParams();

  /*
    Set by the verification page on success. Without it, redeeming a code
    drops the person on a bare sign-in form with no sign anything worked —
    indistinguishable from having been bounced here for failing.
  */
  const justVerified = searchParams.get("verified") === "1";
  // Set by the reset page, for the same reason (ADR-036).
  const justReset = searchParams.get("reset") === "1";

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
            <p className="auth__lede">
              For support teams. Customers don&rsquo;t need an account &mdash; they chat through their
              organisation&rsquo;s link.
            </p>
          </div>

          {justVerified && form.formError === null && (
            <div className="auth__notice" role="status">
              Your email is verified. Sign in to continue.
            </div>
          )}

          {justReset && form.formError === null && (
            <div className="auth__notice" role="status">
              Your password has been reset. Sign in with your new password.
            </div>
          )}

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
                  A link now that the route exists (ADR-036). It carries the
                  address already typed, so the person does not type it twice.
                */}
                <Link
                  className="auth__forgot"
                  to={form.email.trim() ? `/forgot-password?email=${encodeURIComponent(form.email.trim())}` : "/forgot-password"}
                >
                  Forgot password?
                </Link>
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

          {/*
            No "create an account" link: accounts exist only because an admin
            invited somebody (ADR-037). What an invited person does need is the
            step before their first sign-in, and saying so here saves the "the
            password you sent me doesn't work" ticket.
          */}
          <p className="auth__foot">
            Invited recently? <Link to="/verify-email">Enter your code</Link> before signing in.
          </p>
        </div>
      </main>
    </div>
  );
}
