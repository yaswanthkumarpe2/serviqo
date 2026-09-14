import { useId } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { signInPathFor, useForgotPasswordForm } from "@/features/auth/usePasswordResetForms";
import { cn } from "@/utils/cn";

import "./LoginPage.css";

/**
 * Step one of password reset: ask for a code (ADR-036).
 *
 * Linked from the customer and agent sign-in pages, and from nowhere on the
 * admin one — the platform admin cannot be reset by email, and a link that led
 * to a silent no-op would be worse than no link (ADR-036 §6).
 *
 * The header follows the door the person came through. An agent's sign-in page
 * has no route back to the marketing site, so neither does this page when it
 * was reached from there.
 */
export function ForgotPasswordPage() {
  const [searchParams] = useSearchParams();
  const from = searchParams.get("from");
  const form = useForgotPasswordForm({ initialEmail: searchParams.get("email") ?? "", from });

  const emailId = useId();
  const emailErrorId = `${emailId}-error`;
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
            <h1 className="auth__title">Reset your password</h1>
            <p className="auth__lede">Enter the email you sign in with and we&rsquo;ll send you a code.</p>
          </div>

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
                className={cn("field__input", form.fieldError !== null && "field__input--invalid")}
                type="email"
                name="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={form.email}
                onChange={(event) => form.setEmail(event.target.value)}
                aria-invalid={form.fieldError !== null}
                aria-describedby={form.fieldError !== null ? emailErrorId : undefined}
                disabled={form.isSubmitting}
              />
              {form.fieldError !== null && (
                <p className="field__error" id={emailErrorId}>
                  {form.fieldError}
                </p>
              )}
            </div>

            <Button type="submit" variant="primary" className="auth__submit" disabled={form.isSubmitting}>
              {form.isSubmitting ? (
                <>
                  <span className="auth__spinner" aria-hidden="true" />
                  Sending…
                </>
              ) : (
                "Send code"
              )}
            </Button>
          </form>

          <p className="auth__foot">
            Remembered it? <Link to={signInPathFor(from)}>Sign in</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
