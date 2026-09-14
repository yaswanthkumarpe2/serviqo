import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { useLoginForm } from "@/features/auth/useLoginForm";
import { cn } from "@/utils/cn";

import { EyeIcon, EyeOffIcon } from "../auth/passwordIcons";

import "../auth/LoginPage.css";
import "./AdminLoginPage.css";

/**
 * The private sign-in page for Serviqo operators (ADR-032 §14).
 *
 * The SECOND login page, and deliberately not a mode of the first. The two
 * differ in where they send someone, in what they say, and in whether anything
 * links to them — and a single page carrying a `?admin=1` branch would put all
 * three differences inside conditionals that the public page's tests would
 * have to know about.
 *
 * What it is NOT is a second way to authenticate. It posts to the same
 * `POST /auth/login` with the same credentials and receives the same session:
 * there is no separate admin password, no second token audience, and no
 * bypass. The only thing that differs is where a successful sign-in lands,
 * and `PlatformAdminRoute` re-checks the grant against the server when it
 * gets there.
 *
 * Unlisted rather than secret. No navigation, no footer, no sitemap entry and
 * no link from the public login points at this address, which keeps it out of
 * the product's surface — but the URL protects nothing on its own, and the
 * page says as little as possible precisely because anyone may reach it.
 */
export function AdminLoginPage() {
  /*
    Straight to the console. An operator who signs in here and lands on the
    ordinary dashboard would reasonably conclude the grant had failed.

    Someone WITHOUT the grant who signs in here is bounced from /control to
    their own surface by the route guard — silently, because a message would confirm
    what is behind this address.
  */
  const form = useLoginForm({ redirectTo: "/control" });
  const [showPassword, setShowPassword] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;

  /*
    Keeps this page out of search results.

    Set here rather than in `index.html`, which is one document shared by
    every route in a single-page app — a global `noindex` would delist the
    marketing site. The cleanup on unmount is what makes that true: navigating
    away removes the tag, so the meta describes the page actually being
    displayed.

    This is housekeeping, not a defence. A crawler that ignores the tag is
    refused by the server like everyone else.
  */
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);

    return () => {
      meta.remove();
    };
  }, []);

  return (
    <div className="auth adminAuth">
      <header className="auth__bar">
        {/*
          A plain mark, not a link home. Every other page in the product links
          its wordmark back to the marketing site; this one does not, because
          the page is reached deliberately and a person who arrives by mistake
          has nothing here to explore.
        */}
        <span className="brand">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark />
          </span>
          Serviqo
        </span>
        <span className="adminAuth__tag">Operations</span>
      </header>

      <main className="auth__main">
        <div className="auth__card card adminAuth__card">
          <div className="auth__head">
            <h1 className="auth__title">Operations console</h1>
            {/*
              Says what the page is for and nothing about who qualifies. "Staff
              accounts only" would tell a stranger that a staff role exists and
              that this is where to try it.
            */}
            <p className="auth__lede">Sign in to continue.</p>
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
                className={cn("field__input", form.fieldErrors.email && "field__input--invalid")}
                type="email"
                name="email"
                autoComplete="username"
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
            No "create one" link, no password reset, no route back to the
            public site. Every one of those is a door, and this page has
            exactly one.
          */}
        </div>
      </main>
    </div>
  );
}
