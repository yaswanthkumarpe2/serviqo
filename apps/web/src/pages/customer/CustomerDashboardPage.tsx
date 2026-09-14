import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark, SendIcon } from "@/components/ui/icons";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";
import { useCustomerChat } from "@/features/customerChat/useCustomerChat";

import "./CustomerDashboardPage.css";

/**
 * Where a customer lands after signing up or signing in (ADR-034 §6).
 *
 * One screen, one job: talk to support. There is no organization picker, no
 * team roster, no widget installer and no inbox — a customer is not staff, and
 * every one of those belongs to the people answering rather than to the person
 * asking.
 *
 * The chat is REAL. It reads and writes the same `Conversation` and `Message`
 * documents an agent sees in their inbox, through `/api/v1/me`, so a message
 * typed here appears in the agent workspace and a reply typed there appears
 * here. Nothing on this page is a mock.
 */
export function CustomerDashboardPage() {
  const { session, signOut } = useAuth();
  const { user, isLoading: isLoadingUser, error: userError } = useCurrentUser();
  const navigate = useNavigate();
  const chat = useCustomerChat();

  const [draft, setDraft] = useState("");

  /**
   * The bottom of the thread.
   *
   * Scrolled into view whenever a message arrives, because a chat that does
   * not follow its own conversation makes the reader scroll to read the reply
   * they were waiting for.
   */
  const endOfThread = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    /*
      Optional-called, not just optional-chained on the element.

      `scrollIntoView` is not implemented everywhere a React tree can render —
      jsdom has no layout, so the method is simply absent — and calling it
      unguarded throws inside an effect, which React escalates into unmounting
      the whole page. Scrolling is a nicety; the conversation is not. The
      version that cannot take the chat down is the correct one.
    */
    endOfThread.current?.scrollIntoView?.({ block: "end" });
  }, [chat.messages.length]);

  // ProtectedRoute guarantees a session before this renders; the guard keeps
  // the component honest rather than asserting non-null.
  if (session === null) return null;

  function handleSignOut() {
    // Not awaited (ADR-013): the session is cleared before this returns.
    void signOut();
    navigate("/login", { replace: true });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft;
    // Cleared immediately, so the field is ready for the next line rather than
    // holding text the reader has to delete by hand after it sends.
    setDraft("");
    void chat.send(body);
  }

  return (
    <div className="cx">
      <header className="cx__bar">
        <div className="cx__barInner">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              <BrandMark />
            </span>
            Serviqo
          </div>
          <div className="cx__barRight">
            {user !== null && <span className="cx__who">{user.email}</span>}
            <Button variant="secondary" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="cx__main">
        {isLoadingUser ? (
          <p className="cx__muted" role="status">
            Loading your account…
          </p>
        ) : user === null ? (
          /*
            Reached only for a failure that is NOT a 401 — a 401 signs the user
            out and the route guard redirects.
          */
          <p className="cx__alert" role="alert">
            {userError ?? "Could not load your account."}
          </p>
        ) : (
          <>
            <section className="cx__head">
              <h1 className="cx__title">Hi {firstNameOf(user.name)}</h1>
              <p className="cx__lede">Ask us anything — a member of the support team will reply here.</p>
            </section>

            <section className="cx__chat" aria-label="Chat with support">
              {chat.isUnavailable ? (
                /*
                  No organization exists on this deployment yet, so there is
                  literally nobody to talk to. Said plainly rather than as an
                  error, because it is not the reader's fault and retrying
                  cannot change it.
                */
                <div className="cx__empty">
                  <p className="cx__emptyTitle">Support isn&rsquo;t set up yet</p>
                  <p className="cx__muted">Please check back shortly.</p>
                </div>
              ) : chat.error !== null ? (
                <p className="cx__alert" role="alert">
                  {chat.error}
                </p>
              ) : (
                <>
                  <div className="cx__thread">
                    {chat.isLoading ? (
                      <p className="cx__muted" role="status">
                        Opening your chat…
                      </p>
                    ) : chat.messages.length === 0 ? (
                      <div className="cx__empty">
                        <p className="cx__emptyTitle">No messages yet</p>
                        <p className="cx__muted">Send the first one and we&rsquo;ll take it from there.</p>
                      </div>
                    ) : (
                      <ul className="cx__messages">
                        {chat.messages.map((message) => (
                          <li
                            key={message.id}
                            className={
                              message.senderType === "customer"
                                ? "cx__message cx__message--mine"
                                : "cx__message cx__message--theirs"
                            }
                          >
                            <span className="cx__bubble">{message.body}</span>
                            <span className="cx__stamp">
                              {message.senderType === "customer" ? "You" : "Support"} · {formatTime(message.createdAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div ref={endOfThread} />
                  </div>

                  {chat.sendError !== null && (
                    <p className="cx__alert" role="alert">
                      {chat.sendError}
                    </p>
                  )}

                  <form className="cx__composer" onSubmit={handleSubmit}>
                    <label className="cx__srOnly" htmlFor="cx-message">
                      Your message
                    </label>
                    <input
                      id="cx-message"
                      className="cx__input"
                      type="text"
                      autoComplete="off"
                      placeholder="Type your message…"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      disabled={chat.isLoading || chat.conversationId === null}
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      /*
                        Disabled on an empty draft as well as while sending: a
                        button that accepts a click and does nothing is worse
                        than one that says it is not ready.
                      */
                      disabled={chat.isSending || draft.trim().length === 0 || chat.conversationId === null}
                    >
                      <SendIcon aria-hidden="true" />
                      {chat.isSending ? "Sending…" : "Send"}
                    </Button>
                  </form>
                </>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/** The greeting uses a first name; the bar carries the address. */
function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first === undefined || first.length === 0 ? name : first;
}

/** Guarded: the value comes off the wire, and an invalid date renders as literal text. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
