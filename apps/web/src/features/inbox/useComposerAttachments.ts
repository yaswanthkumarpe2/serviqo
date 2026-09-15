import { useCallback, useEffect, useRef, useState } from "react";

import type { InboxAttachment } from "./inboxApi";

/**
 * Files an agent has picked for the next reply (ADR-041 §6): each is uploaded
 * as soon as it is picked, so sending is instant once they are ready.
 */

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 5;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"];

export interface PendingAttachment {
  key: number;
  file: File;
  status: "uploading" | "ready" | "failed";
  uploaded: InboxAttachment | null;
  previewUrl: string | null;
  error: string | null;
}

export function problemWith(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Only images, PDFs and text files can be sent.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > ATTACHMENT_MAX_BYTES) return "Files can be at most 10 MB.";
  return null;
}

export function useComposerAttachments(upload: (file: File) => Promise<InboxAttachment>) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const nextKey = useRef(1);
  const itemsRef = useRef(items);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Object URLs outlive their images unless revoked.
  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        if (item.previewUrl !== null && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  const patch = useCallback((key: number, change: Partial<PendingAttachment>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const start = useCallback(
    (key: number, file: File) => {
      patch(key, { status: "uploading", error: null });
      upload(file).then(
        (uploaded) => patch(key, { status: "ready", uploaded }),
        () => patch(key, { status: "failed", error: "Upload failed" }),
      );
    },
    [patch, upload],
  );

  const add = useCallback(
    (files: File[]) => {
      setNotice(null);
      const accepted: PendingAttachment[] = [];
      let room = ATTACHMENTS_PER_MESSAGE - itemsRef.current.length;

      for (const file of files) {
        if (room <= 0) {
          setNotice(`You can send up to ${ATTACHMENTS_PER_MESSAGE} files at a time.`);
          break;
        }
        const problem = problemWith(file);
        if (problem !== null) {
          setNotice(problem);
          continue;
        }
        room -= 1;
        accepted.push({
          key: nextKey.current++,
          file,
          status: "uploading",
          uploaded: null,
          previewUrl:
            file.type.startsWith("image/") && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null,
          error: null,
        });
      }

      if (accepted.length === 0) return;
      const next = [...itemsRef.current, ...accepted];
      itemsRef.current = next;
      setItems(next);
      for (const item of accepted) start(item.key, item.file);
    },
    [start],
  );

  const remove = useCallback((key: number) => {
    const item = itemsRef.current.find((entry) => entry.key === key);
    if (item?.previewUrl != null && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(item.previewUrl);
    const next = itemsRef.current.filter((entry) => entry.key !== key);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const retry = useCallback(
    (key: number) => {
      const item = itemsRef.current.find((entry) => entry.key === key);
      if (item !== undefined) start(key, item.file);
    },
    [start],
  );

  /** Drops the files that were just sent, by their uploaded ids. */
  const clear = useCallback(
    (sentIds: string[]) => {
      for (const item of itemsRef.current) {
        if (item.uploaded !== null && sentIds.includes(item.uploaded.id)) remove(item.key);
      }
    },
    [remove],
  );

  return {
    items,
    notice,
    add,
    remove,
    retry,
    clear,
    isUploading: items.some((item) => item.status === "uploading"),
    readyIds: items.flatMap((item) => (item.status === "ready" && item.uploaded !== null ? [item.uploaded.id] : [])),
  };
}
