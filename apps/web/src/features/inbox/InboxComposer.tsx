import { useEffect, useRef, useState } from "react";

import { NoteIcon, PaperclipIcon, SmileIcon } from "@/features/workspace/workspaceIcons";

import { matchSavedReplies, matchTeammates, mentionAt, mentionedIds, savedReplyQuery } from "./composerSuggestions";
import { EMOJI } from "./linkify";
import { useComposerAttachments } from "./useComposerAttachments";

import type { InboxAttachment, SavedReply, Teammate } from "./inboxApi";

/**
 * The reply box: text, emoji and files (ADR-041 §6), saved replies and
 * internal notes with @mentions (ADR-042 §1–2).
 *
 * Mounted with `key={conversationId}`, so a half-written reply and the files
 * picked for it never follow the agent into a different customer's thread.
 *
 * Two modes, and the difference is made loud on purpose: a note is written
 * on a yellow surface under "Only your team sees this", because sending a
 * note to a customer by mistake is the one error this box must not invite.
 */

export type ComposerMode = "reply" | "note";

export interface InboxComposerProps {
  isSending: boolean;
  send: (body: string, attachmentIds: string[]) => Promise<boolean>;
  upload: (file: File) => Promise<InboxAttachment>;
  onTyping: () => void;
  addNote: (body: string, mentionedUserIds: string[]) => Promise<boolean>;
  savedReplies: SavedReply[];
  teammates: Teammate[];
  currentUserId: string | null;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
}

export const COMPOSER_INPUT_ID = "inbox-composer";

type Suggestion = { kind: "reply"; reply: SavedReply } | { kind: "mention"; teammate: Teammate; start: number };

export function InboxComposer({
  isSending,
  send,
  upload,
  onTyping,
  addNote,
  savedReplies,
  teammates,
  currentUserId,
  mode,
  onModeChange,
}: InboxComposerProps) {
  const [draft, setDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<Teammate[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useComposerAttachments(upload);

  const isNote = mode === "note";
  const value = isNote ? noteDraft : draft;
  const setValue = isNote ? setNoteDraft : setDraft;

  // ---- suggestions ----

  let suggestions: Suggestion[] = [];
  if (dismissedFor !== value) {
    if (!isNote) {
      const query = savedReplyQuery(draft);
      if (query !== null) suggestions = matchSavedReplies(savedReplies, query).map((reply) => ({ kind: "reply", reply }));
    } else {
      const mention = mentionAt(noteDraft, cursor);
      if (mention !== null) {
        suggestions = matchTeammates(teammates, mention.query, currentUserId).map((teammate) => ({
          kind: "mention",
          teammate,
          start: mention.start,
        }));
      }
    }
  }
  const active = Math.min(highlighted, Math.max(0, suggestions.length - 1));

  function focusAt(position: number) {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
      setCursor(position);
    });
  }

  function choose(suggestion: Suggestion) {
    setHighlighted(0);
    if (suggestion.kind === "reply") {
      setDraft(suggestion.reply.body);
      focusAt(suggestion.reply.body.length);
      onTyping();
      return;
    }
    const name = suggestion.teammate.name ?? "";
    const next = `${noteDraft.slice(0, suggestion.start)}@${name} ${noteDraft.slice(cursor)}`;
    setNoteDraft(next);
    setPicked((current) => (current.some((t) => t.id === suggestion.teammate.id) ? current : [...current, suggestion.teammate]));
    focusAt(suggestion.start + name.length + 2);
  }

  // ---- sending ----

  const canSend = isNote
    ? !isSending && noteDraft.trim().length > 0
    : !isSending && !attachments.isUploading && (draft.trim().length > 0 || attachments.readyIds.length > 0);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    setEmojiOpen(false);

    if (isNote) {
      const body = noteDraft;
      setNoteDraft("");
      const saved = await addNote(body, mentionedIds(body, picked));
      if (saved) setPicked([]);
      else setNoteDraft((current) => (current.length === 0 ? body : current));
      return;
    }

    const body = draft;
    const ids = attachments.readyIds;
    // Cleared optimistically so a fast second message is not typed into stale
    // text; a failure surfaces beneath the composer and restores the text.
    setDraft("");
    const sent = await send(body, ids);
    if (sent) attachments.clear(ids);
    else setDraft((current) => (current.length === 0 ? body : current));
  }

  function insertEmoji(emoji: string) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    setValue(value.slice(0, start) + emoji + value.slice(end));
    setEmojiOpen(false);
    focusAt(start + emoji.length);
  }

  useEffect(() => {
    if (!emojiOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setEmojiOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [emojiOpen]);

  return (
    <div
      className={`inbox__composerWrap${isNote ? " inbox__composerWrap--note" : ""}`}
      onDragOver={(event) => {
        if (!isNote && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (isNote || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        attachments.add(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="inbox__modes" role="tablist" aria-label="Composer mode">
        <button type="button" role="tab" className="inbox__mode" aria-selected={!isNote} onClick={() => onModeChange("reply")}>
          Reply
        </button>
        <button type="button" role="tab" className="inbox__mode inbox__mode--note" aria-selected={isNote} onClick={() => onModeChange("note")}>
          <NoteIcon aria-hidden="true" />
          Internal note
        </button>
        {isNote && <span className="inbox__noteHint">Only your team sees this. Type @ to mention someone.</span>}
        {!isNote && savedReplies.length > 0 && <span className="inbox__noteHint">Type / for saved replies.</span>}
      </div>

      {suggestions.length > 0 && (
        <ul className="inbox__suggestions" role="listbox" aria-label={isNote ? "Mention a teammate" : "Saved replies"}>
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.kind === "reply" ? suggestion.reply.id : suggestion.teammate.id}
              role="option"
              aria-selected={index === active}
              className="inbox__suggestion"
              onMouseDown={(event) => {
                event.preventDefault();
                choose(suggestion);
              }}
            >
              {suggestion.kind === "reply" ? (
                <>
                  <span className="inbox__suggestionKey">/{suggestion.reply.shortcut}</span>
                  <span className="inbox__suggestionTitle">{suggestion.reply.title}</span>
                </>
              ) : (
                <span className="inbox__suggestionTitle">@{suggestion.teammate.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {emojiOpen && (
        <div className="inbox__emoji" role="group" aria-label="Emoji">
          {EMOJI.map((emoji) => (
            <button key={emoji} type="button" className="inbox__emojiOption" aria-label={`Insert ${emoji}`} onClick={() => insertEmoji(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}

      {!isNote && attachments.items.length > 0 && (
        <ul className="inbox__tray" aria-label="Files to send">
          {attachments.items.map((item) => (
            <li key={item.key} className={`inbox__chip inbox__chip--${item.status}`}>
              {item.previewUrl !== null && <img className="inbox__chipThumb" src={item.previewUrl} alt="" />}
              <span className="inbox__chipName">{item.file.name}</span>
              {item.status === "uploading" && <span className="inbox__chipState">Uploading…</span>}
              {item.status === "failed" && (
                <button type="button" className="inbox__chipState" onClick={() => attachments.retry(item.key)}>
                  {item.error} · Retry
                </button>
              )}
              <button
                type="button"
                className="inbox__chipRemove"
                aria-label={`Remove ${item.file.name}`}
                onClick={() => attachments.remove(item.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {!isNote && attachments.notice !== null && (
        <p className="inbox__state inbox__state--error" role="alert">
          {attachments.notice}
        </p>
      )}

      <form className="inbox__composer" onSubmit={handleSubmit}>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
          className="inbox__srOnly"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            attachments.add(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <div className="inbox__tools">
          {!isNote && (
            <button type="button" className="inbox__tool" aria-label="Attach a file" onClick={() => fileRef.current?.click()} disabled={isSending}>
              <PaperclipIcon />
            </button>
          )}
          <button
            type="button"
            className="inbox__tool"
            aria-label="Insert emoji"
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((open) => !open)}
            disabled={isSending}
          >
            <SmileIcon />
          </button>
        </div>
        <label className="inbox__srOnly" htmlFor={COMPOSER_INPUT_ID}>
          {isNote ? "Write an internal note" : "Reply to this conversation"}
        </label>
        <textarea
          ref={inputRef}
          id={COMPOSER_INPUT_ID}
          className="inbox__input"
          value={value}
          rows={2}
          placeholder={isNote ? "Write a note for your team…" : "Write a reply…"}
          aria-autocomplete="list"
          onChange={(event) => {
            setValue(event.target.value);
            setCursor(event.target.selectionStart ?? event.target.value.length);
            setHighlighted(0);
            if (!isNote) onTyping();
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
          onPaste={(event) => {
            if (isNote) return;
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            attachments.add(files);
          }}
          onKeyDown={(event) => {
            if (suggestions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlighted((active + step + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                choose(suggestions[active]!);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedFor(value);
                return;
              }
            }
            // Enter sends and Shift+Enter starts a new line, as in the widget.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={isSending}
        />
        <button type="submit" className={`inbox__send${isNote ? " inbox__send--note" : ""}`} disabled={!canSend}>
          {isSending ? "Saving…" : isNote ? "Add note" : "Send"}
        </button>
      </form>
    </div>
  );
}
