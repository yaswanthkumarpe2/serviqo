import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { ChatIcon } from "@/features/workspace/workspaceIcons";

import { createSavedReply, deleteSavedReply, fetchSavedReplies, updateSavedReply } from "./inboxApi";

import type { SavedReply } from "./inboxApi";
import type { FormEvent } from "react";

import "./SavedRepliesSettings.css";

/**
 * The team's saved replies (ADR-042 §1): write one, give it a shortcut, and
 * every agent can insert it by typing `/shortcut` in a reply.
 *
 * Editing needs `saved_reply.manage` (owners, admins, supervisors). The caller
 * passes `canManage` from the server-confirmed role so the form is not offered
 * to someone the server would refuse — the server still decides.
 */

interface SavedRepliesSettingsProps {
  organizationId: string;
  canManage: boolean;
}

type Draft = { shortcut: string; title: string; body: string };
const EMPTY: Draft = { shortcut: "", title: "", body: "" };

function messageFor(caught: unknown): string {
  if (caught instanceof AuthApiError) {
    if (caught.code === "SAVED_REPLY_SHORTCUT_TAKEN") return "Another saved reply already uses that shortcut.";
    if (caught.code === "SAVED_REPLY_LIMIT_REACHED") return "You have reached the limit of saved replies.";
    if (caught.status === 400) return caught.issues[0]?.message ?? "Check the fields and try again.";
    if (caught.status === 403) return "Your role cannot change saved replies.";
  }
  return "That did not work. Please try again.";
}

export function SavedRepliesSettings({ organizationId, canManage }: SavedRepliesSettingsProps) {
  const { authorizedFetch } = useAuth();
  const baseId = useId();
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSavedReplies(authorizedFetch, organizationId).then(
      (loaded) => !cancelled && setReplies(loaded),
      () => !cancelled && setLoadError("Saved replies could not be loaded."),
    );
    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId]);

  function startEditing(reply: SavedReply | null) {
    setError(null);
    setEditingId(reply === null ? "new" : reply.id);
    setDraft(reply === null ? EMPTY : { shortcut: reply.shortcut, title: reply.title, body: reply.body });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    const input = { shortcut: draft.shortcut.trim().toLowerCase(), title: draft.title.trim(), body: draft.body.trim() };
    try {
      if (editingId === "new") {
        const created = await createSavedReply(authorizedFetch, organizationId, input);
        setReplies((current) => [...(current ?? []), created].sort((a, b) => a.shortcut.localeCompare(b.shortcut)));
      } else if (editingId !== null) {
        const updated = await updateSavedReply(authorizedFetch, organizationId, editingId, input);
        setReplies((current) =>
          (current ?? []).map((reply) => (reply.id === updated.id ? updated : reply)).sort((a, b) => a.shortcut.localeCompare(b.shortcut)),
        );
      }
      setEditingId(null);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(reply: SavedReply) {
    if (!window.confirm(`Delete the saved reply "/${reply.shortcut}"?`)) return;
    try {
      await deleteSavedReply(authorizedFetch, organizationId, reply.id);
      setReplies((current) => (current ?? []).filter((entry) => entry.id !== reply.id));
    } catch (caught) {
      setError(messageFor(caught));
    }
  }

  return (
    <section className="savedReplies card pad" aria-labelledby={`${baseId}-heading`}>
      <div className="savedReplies__head">
        <span className="savedReplies__icon" aria-hidden="true">
          <ChatIcon />
        </span>
        <div className="savedReplies__intro">
          <h2 className="h3" id={`${baseId}-heading`}>
            Saved replies
          </h2>
          <p className="savedReplies__hint">
            Answers your team sends often. In a reply, type <kbd>/</kbd> and the shortcut to insert one.
          </p>
        </div>
        {canManage && editingId === null && (
          <Button type="button" variant="secondary" size="sm" onClick={() => startEditing(null)}>
            New saved reply
          </Button>
        )}
      </div>

      {loadError !== null && (
        <p className="savedReplies__error" role="alert">
          {loadError}
        </p>
      )}

      {editingId !== null && (
        <form className="savedReplies__form" onSubmit={handleSubmit} noValidate>
          <div className="savedReplies__row">
            <label className="savedReplies__field">
              <span>Shortcut</span>
              <span className="savedReplies__shortcutInput">
                /
                <input
                  className="appearance__input appearance__input--mono"
                  value={draft.shortcut}
                  maxLength={32}
                  required
                  placeholder="refund"
                  onChange={(event) => setDraft({ ...draft, shortcut: event.target.value })}
                />
              </span>
            </label>
            <label className="savedReplies__field savedReplies__field--grow">
              <span>Title</span>
              <input
                className="appearance__input"
                value={draft.title}
                maxLength={80}
                required
                placeholder="Refund policy"
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </label>
          </div>
          <label className="savedReplies__field">
            <span>Message</span>
            <textarea
              className="appearance__input"
              value={draft.body}
              rows={4}
              maxLength={4000}
              required
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </label>
          {error !== null && (
            <p className="savedReplies__error" role="alert">
              {error}
            </p>
          )}
          <div className="savedReplies__actions">
            <Button
              type="submit"
              variant="primary"
              disabled={isSaving || draft.shortcut.trim() === "" || draft.title.trim() === "" || draft.body.trim() === ""}
            >
              {isSaving ? "Saving…" : "Save reply"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditingId(null)} disabled={isSaving}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {editingId === null && error !== null && (
        <p className="savedReplies__error" role="alert">
          {error}
        </p>
      )}

      {replies === null && loadError === null && (
        <p className="savedReplies__hint" role="status">
          Loading saved replies…
        </p>
      )}

      {replies !== null && replies.length === 0 && editingId === null && (
        <p className="savedReplies__hint">No saved replies yet.</p>
      )}

      {replies !== null && replies.length > 0 && (
        <ul className="savedReplies__list">
          {replies.map((reply) => (
            <li key={reply.id} className="savedReplies__item">
              <div className="savedReplies__itemText">
                <p className="savedReplies__itemHead">
                  <code>/{reply.shortcut}</code> {reply.title}
                </p>
                <p className="savedReplies__itemBody">{reply.body}</p>
              </div>
              {canManage && (
                <div className="savedReplies__itemActions">
                  <Button type="button" variant="secondary" size="sm" onClick={() => startEditing(reply)} disabled={editingId !== null}>
                    Edit
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => void handleDelete(reply)} aria-label={`Delete /${reply.shortcut}`}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
