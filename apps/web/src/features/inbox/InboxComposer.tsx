import { useEffect, useRef, useState } from "react";

import { PaperclipIcon, SmileIcon } from "@/features/workspace/workspaceIcons";

import { EMOJI } from "./linkify";
import { useComposerAttachments } from "./useComposerAttachments";

import type { InboxAttachment } from "./inboxApi";

/**
 * The reply box: text, emoji, and files (ADR-041 §6).
 *
 * Mounted with `key={conversationId}`, so a half-written reply and the files
 * picked for it never follow the agent into a different customer's thread.
 */

export interface InboxComposerProps {
  isSending: boolean;
  send: (body: string, attachmentIds: string[]) => Promise<boolean>;
  upload: (file: File) => Promise<InboxAttachment>;
  onTyping: () => void;
}

export function InboxComposer({ isSending, send, upload, onTyping }: InboxComposerProps) {
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useComposerAttachments(upload);

  const canSend =
    !isSending && !attachments.isUploading && (draft.trim().length > 0 || attachments.readyIds.length > 0);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const body = draft;
    const ids = attachments.readyIds;
    // Cleared optimistically so a fast second message is not typed into stale
    // text; a failure surfaces beneath the composer and restores the text.
    setDraft("");
    setEmojiOpen(false);
    const sent = await send(body, ids);
    if (sent) attachments.clear(ids);
    else setDraft((current) => (current.length === 0 ? body : current));
  }

  function insertEmoji(emoji: string) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
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
      className="inbox__composerWrap"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        attachments.add(Array.from(event.dataTransfer.files));
      }}
    >
      {emojiOpen && (
        <div className="inbox__emoji" role="group" aria-label="Emoji">
          {EMOJI.map((emoji) => (
            <button key={emoji} type="button" className="inbox__emojiOption" aria-label={`Insert ${emoji}`} onClick={() => insertEmoji(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}

      {attachments.items.length > 0 && (
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

      {attachments.notice !== null && (
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
          <button type="button" className="inbox__tool" aria-label="Attach a file" onClick={() => fileRef.current?.click()} disabled={isSending}>
            <PaperclipIcon />
          </button>
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
        <label className="inbox__srOnly" htmlFor="inbox-composer">
          Reply to this conversation
        </label>
        <textarea
          ref={inputRef}
          id="inbox-composer"
          className="inbox__input"
          value={draft}
          rows={2}
          placeholder="Write a reply…"
          onChange={(event) => {
            setDraft(event.target.value);
            onTyping();
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            attachments.add(files);
          }}
          onKeyDown={(event) => {
            // Enter sends and Shift+Enter starts a new line, as in the widget.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={isSending}
        />
        <button type="submit" className="inbox__send" disabled={!canSend}>
          {isSending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
