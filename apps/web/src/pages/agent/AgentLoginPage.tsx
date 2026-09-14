import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { useLoginForm } from "@/features/auth/useLoginForm";
import { cn } from "@/utils/cn";

import { EyeIcon, EyeOffIcon } from "../auth/passwordIcons";

import "../auth/LoginPage.css";

/**
 * Where support agents sign in (ADR-034 §9).
 *
 * The THIRD login page, and the reason there are three: Serviqo now has three
 * kinds of person, and each arrives from somewhere different. Customers come
 * from the marketing site and register themselves. Agents are created by an
 * admin and arrive from a link in an email. Admins come from an unlisted
 * address they were told once.
 *
 * Not a mode of `/login`. The two differ in where they send somebody and in
 * what they offer — this page has no sign-up link, because an agent CANNOT
 * sign themselves up; an account exists only because an admin made one.
 *
 * It is not a separate way to AUTHENTICATE. It posts to the same
 * `POST /auth/login` with the same credentials and receives the same session.
 * The destination is the only difference, and the route guard re-checks the
 * account's kind against the server when it gets there.
 */
export function AgentLoginPage() {
  /*
    Straight to the agent workspace. A customer who wandered here and signed in
    is redirected to their own dashboard by the guard on `/agent` — silently,
    because being told "this page is for agents" invites the next question.
  */
  const form = useLoginForm({ redirectTo: "/agent" });
  const [showPassword, setShowPassword] = useState(false);
  const [searchParams] = useSearchParams();
  // Set by the reset page when the person came from this door (ADR-036).
  const justReset = searchParams.get("reset") === "1";

  const emailId = useId();
  const passwordId = useId();
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;

  return (
    <div className="auth">
      <header className="auth__bar">
        <span className="brand">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark />
          </span>
          Serviqo
        </span>
      </header>

      <main className="auth__main">
        <div className="auth__card card">
          <div className="auth__head">
            <h1 className="auth__title">Agent sign-in</h1>
            {/*
              Names the one thing an agent arriving for the first time needs to
              know, because they will have a password from an email and no idea
              that a code has to come first. Saying it here saves the support
              ticket that "the password you sent me doesn't work" otherwise
              becomes.
            */}
            <p className="auth__lede">
              First time here? Enter the code from your invitation email before signing in.
            </p>
          </div>

          {justReset && form.formError === null && (
            <div className="auth__notice" role="status">
              Your password has been reset. Sign in with your new password.
            </div>
          )}

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
                  autoComplete="current-password"
                  placeholder="From your invitation email"
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
            Reset IS offered here, unlike sign-up (ADR-036). An agent who lost
            the invitation mail, or forgot the password they chose, recovers
            through their own inbox — which is also how an unverified agent
            gets in without a second invitation, since redeeming a reset code
            proves the address just as the invitation's code would have.
          */}
          <p className="auth__foot">
            <Link
              to={
                form.email.trim()
                  ? `/forgot-password?from=agent&email=${encodeURIComponent(form.email.trim())}`
                  : "/forgot-password?from=agent"
              }
            >
              Forgot your password?
            </Link>
          </p>

          {/*
            No "create one" link, deliberately. An agent account exists because
            an admin created it; offering self-registration here would send the
            person to the customer front door and give them the wrong kind of
            account under the address their invitation was sent to.
          */}
        </div>
      </main>
    </div>
  );
}
