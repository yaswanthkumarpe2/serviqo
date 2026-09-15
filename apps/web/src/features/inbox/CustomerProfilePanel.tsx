import { useEffect, useState } from "react";

import { ShieldIcon } from "@/features/workspace/workspaceIcons";

import { useCustomerProfile } from "./useCustomerProfile";

import type { CustomerSearchResult } from "./customerProfileApi";

import "./CustomerProfilePanel.css";

/**
 * The contact beside a conversation (ADR-043): who they are, what the team
 * knows about them, their earlier conversations, and — for owners, admins and
 * supervisors — blocking and merging duplicates.
 *
 * `canManage` is the server-confirmed role's answer, used only to decide which
 * controls to offer. The server decides every action.
 */

interface CustomerProfilePanelProps {
  organizationId: string;
  customerId: string;
  canManage: boolean;
  currentConversationId: string;
  onOpenConversation: (conversationId: string) => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function CustomerProfilePanel({
  organizationId,
  customerId,
  canManage,
  currentConversationId,
  onOpenConversation,
}: CustomerProfilePanelProps) {
  const profile = useCustomerProfile(organizationId, customerId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "" });
  const [note, setNote] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerSearchResult[]>([]);

  const data = profile.profile;
  const noteValue = note ?? data?.profileNote ?? "";

  useEffect(() => {
    if (!mergeOpen || query.trim().length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void profile.search(query.trim()).then((found) => !cancelled && setResults(found));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `profile.search` is rebuilt each render; the query is what should trigger a search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeOpen, query]);

  if (profile.loadError !== null) {
    // Not an alert: the conversation beside it is fully usable without the contact panel.
    return (
      <aside className="profile" aria-label="Contact">
        <p className="profile__muted" role="status">
          Contact details are unavailable right now.
        </p>
      </aside>
    );
  }

  if (data === null) {
    return (
      <aside className="profile" aria-label="Contact">
        <p className="profile__muted" role="status">
          Loading contact…
        </p>
      </aside>
    );
  }

  const busy = profile.pending !== null;

  return (
    <aside className="profile" aria-label="Contact">
      <div className="profile__head">
        <h3 className="profile__name">{data.name ?? "Anonymous visitor"}</h3>
        {data.blocked && (
          <span className="profile__blocked">
            <ShieldIcon aria-hidden="true" width={12} height={12} />
            Blocked
          </span>
        )}
      </div>
      <p className="profile__muted">
        First seen {formatDate(data.createdAt)} · last seen {formatDate(data.lastSeenAt)}
      </p>

      {editing ? (
        <form
          className="profile__form"
          onSubmit={(event) => {
            event.preventDefault();
            void profile
              .save({ name: draft.name.trim() || null, email: draft.email.trim() || null, phone: draft.phone.trim() || null })
              .then((saved) => saved && setEditing(false));
          }}
        >
          {(["name", "email", "phone"] as const).map((field) => (
            <label key={field} className="profile__field">
              <span>{field === "name" ? "Name" : field === "email" ? "Email" : "Phone"}</span>
              <input
                className="profile__input"
                type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
                value={draft[field]}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              />
            </label>
          ))}
          <div className="profile__actions">
            <button type="submit" className="profile__button profile__button--primary" disabled={busy}>
              {profile.pending === "save" ? "Saving…" : "Save"}
            </button>
            <button type="button" className="profile__button" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <dl className="profile__details">
          <div>
            <dt>Email</dt>
            <dd>{data.email ?? "—"}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{data.phone ?? "—"}</dd>
          </div>
          <button
            type="button"
            className="profile__link"
            onClick={() => {
              setDraft({ name: data.name ?? "", email: data.email ?? "", phone: data.phone ?? "" });
              setEditing(true);
            }}
          >
            Edit details
          </button>
        </dl>
      )}

      <label className="profile__field">
        <span>Team note about this contact</span>
        <textarea
          className="profile__input"
          rows={3}
          maxLength={2000}
          placeholder="Only your team sees this"
          value={noteValue}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {note !== null && note !== (data.profileNote ?? "") && (
        <div className="profile__actions">
          <button
            type="button"
            className="profile__button profile__button--primary"
            disabled={busy}
            onClick={() => void profile.save({ profileNote: note.trim() || null }).then((saved) => saved && setNote(null))}
          >
            Save note
          </button>
          <button type="button" className="profile__button" onClick={() => setNote(null)} disabled={busy}>
            Discard
          </button>
        </div>
      )}

      {data.conversations.length > 1 && (
        <div className="profile__section">
          <h4 className="profile__sectionTitle">Conversations ({data.conversations.length})</h4>
          <ul className="profile__conversations">
            {data.conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className="profile__conversation"
                  aria-current={conversation.id === currentConversationId ? "true" : undefined}
                  onClick={() => onOpenConversation(conversation.id)}
                >
                  <span>{formatDate(conversation.lastMessageAt)}</span>
                  <span className="profile__muted">
                    {conversation.status === "closed" ? "Closed" : "Open"}
                    {conversation.tags.length > 0 ? ` · ${conversation.tags.join(", ")}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {profile.error !== null && (
        <p className="profile__error" role="alert">
          {profile.error}
        </p>
      )}

      {canManage && (
        <div className="profile__section profile__manage">
          {data.blocked ? (
            <>
              <p className="profile__muted">
                Blocked{data.blockedBy?.name ? ` by ${data.blockedBy.name}` : ""}
                {data.blockedAt ? ` on ${formatDate(data.blockedAt)}` : ""}. They cannot start or continue a chat.
              </p>
              <button type="button" className="profile__button" onClick={() => void profile.unblock()} disabled={busy}>
                {profile.pending === "unblock" ? "Unblocking…" : "Unblock"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="profile__button profile__button--danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Block this visitor? Their open conversation closes and they can no longer chat.")) {
                  void profile.block();
                }
              }}
            >
              {profile.pending === "block" ? "Blocking…" : "Block visitor"}
            </button>
          )}

          <button type="button" className="profile__link" onClick={() => setMergeOpen((open) => !open)} aria-expanded={mergeOpen}>
            Merge a duplicate contact into this one
          </button>
          {mergeOpen && (
            <div className="profile__merge">
              <label className="profile__field">
                <span>Find the duplicate</span>
                <input
                  className="profile__input"
                  type="search"
                  placeholder="Name, email or phone"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              {query.trim().length >= 2 && results.length === 0 && <p className="profile__muted">No other contacts match.</p>}
              <ul className="profile__results">
                {query.trim().length >= 2 &&
                  results.map((result) => (
                    <li key={result.id} className="profile__result">
                      <span>
                        {result.name ?? "Anonymous visitor"}
                        <span className="profile__muted"> {[result.email, result.phone].filter(Boolean).join(" · ")}</span>
                      </span>
                      <button
                        type="button"
                        className="profile__button"
                        disabled={busy}
                        onClick={() => {
                          const label = result.name ?? result.email ?? "this contact";
                          if (window.confirm(`Merge ${label} into ${data.name ?? "this contact"}? Their conversations move here.`)) {
                            void profile.merge(result.id).then((merged) => {
                              if (merged) {
                                setMergeOpen(false);
                                setQuery("");
                                setResults([]);
                              }
                            });
                          }
                        }}
                      >
                        Merge
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
