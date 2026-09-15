# ADR-041: Files, Emoji and Links in Chats

**Status:** Accepted
**Date:** 2026-09-15
**Amends:** [ADR-022](./022-persistent-conversations-and-messages.md) §9 (a message body is required); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §13 (agent replies share the 30/hour write bound)
**Related:** [ADR-040](./040-live-chat-essentials.md) (the rest of Phase 1); [ADR-021](./021-embeddable-widget-loader-shell-and-isolation.md) §2 (the widget shares no code with the dashboard)

## Context

A modern support chat must let both sides send pictures and documents: a
customer's photo of a damaged parcel, or an agent's invoice. It must also turn
URLs into clickable links and offer emoji.

Two constraints shape the design:

- Customers never sign in ([ADR-037](./037-customers-never-authenticate.md)).
  A picture shown in an `<img>` tag cannot carry a bearer token.
- A file is untrusted content that will be opened on staff machines and on
  customers' own sites.

## Decisions

### 1. Upload first, then send

Sending a file takes two requests:

1. **Upload.** The file goes into one conversation. The response is
   `{ id, name, contentType, size, url }`.
2. **Send.** A message names the uploads it carries in `attachmentIds`, at most
   five. This works over REST, over the widget socket's `message:send`, and in
   the agent reply.

What `messageService` does with a send:

- It generates the message id first.
- In one conditional `updateMany`, it claims the attachments for that id. Every
  one must belong to the same organisation and conversation, have been uploaded
  by the same side (customer or agent), and not yet be in a message.
- If fewer are claimed than were named, the claim is undone and the whole send
  is refused with 400. If the message insert then fails, the claim is released.

What that guarantees:

- A file cannot be sent twice.
- A file cannot be borrowed from another conversation.
- An agent cannot send a customer's upload as their own.

**Message storage.** A message copies each attachment's name, type, size and
key into `Message.attachments`, so reading history needs no join. Messages never
change, so the copy cannot go stale.

**Message body.** `body` may now be empty when there is at least one attachment
(amends ADR-022 §9). A message with neither text nor files is still refused, on
`body`, at both the schema and the model.

### 2. Upload endpoints and file checks

**Endpoints:**

- `POST /api/v1/widget/conversations/:id/attachments`: widget token; the
  visitor's own open conversation.
- `POST /api/v1/organizations/:orgId/conversations/:id/attachments`:
  `conversation.reply` in the organisation.

**Request format:**

- The request body is the raw file, with its type in `Content-Type` and its name
  URI-encoded in `X-Filename`.
- There is no multipart parser.
- `express.raw` runs *after* authentication, the rate limiter and the permission
  check, so a refused caller never makes the server buffer a file.

**Allowed files:**

- PNG, JPEG, GIF and WebP images, PDF, and plain text, up to 10 MB.
- The bytes must match the claimed type: magic numbers are checked, and text may
  contain no NUL bytes.
- SVG and HTML are refused because they are documents that can run script.
- Names are stripped of paths, control characters and quotes, and bounded to
  120 characters.
- An upload to a closed conversation gets 409; another tenant's conversation
  gets the usual opaque 404.

**Storage.** Bytes go to a GridFS bucket (`attachments`) in the same database,
so a deployment needs no second storage service. The widget's CORS preflight
now allows `X-Filename`.

### 3. Downloads: the link is the credential

`GET /api/v1/files/:id/:name?key=…` streams the file.

**Access:**

- `key` is 256 random bits, stored on the attachment and copied into the
  message. Only people who can read the message ever see it.
- A wrong id, a wrong key, and an uploaded-but-unsent file all get one
  identical 404. The unsent case stops uploads from being used as free file
  hosting.

**Response headers:**

- `Content-Disposition: inline` for images; `attachment` for everything else,
  with an RFC 5987 UTF-8 name.
- `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`: even a mislabelled
  file rendered as a document can run nothing.
- `Cross-Origin-Resource-Policy: cross-origin`, so the embedded widget can show
  the image on a customer's site. The rest of the API stays `same-origin`.

**Logging.** Request logs redact the `key` query value.

**Hosted page CSP.** The hosted-page policy adds `blob:` to `img-src`, for
local thumbnails of files picked but not yet sent.

### 4. Upload rate limits

There are two new limiter classes, both allowing 40 uploads per 15 minutes:

- `widgetAttachmentUpload`, keyed by customer;
- `attachmentUpload`, keyed by user.

The global per-IP bound also applies.

### 5. Agent conversation writes get their own limiter

ADR-025 §13 recorded that 30 writes an hour was too low for an agent working a
queue, and named the fix. `agentConversationWrite` now bounds replies, claims
and status changes at 120 per 5 minutes per user. `authenticatedWrite` keeps its
bound for configuration changes.

### 6. What people see

In both the widget and the inbox:

- **Attaching files:** a paperclip button, drag-and-drop, and pasting a
  screenshot all attach. Each file uploads as soon as it is picked and shows as
  a chip with a thumbnail, "Uploading…", or "Upload failed · Retry".
- **Sending:** Send waits for uploads to finish. A failed send keeps both the
  text and the files.
- **In the thread:** pictures show in the bubble and open full size in a new
  tab. Other files show as a card with the name and size.
- **Emoji:** a small built-in picker of 32 common emoji, with no library and no
  network requests.
- **Links:** `http(s)://…` and `www.…` in message text become links that open in
  a new tab with `rel="noopener noreferrer nofollow"`.
  - Sentence punctuation and an unbalanced closing bracket are left out of the
    link.
  - Only a URL that parses as http or https becomes a link, so `javascript:`
    stays text.
  - Text is still written as text: DOM text nodes in the widget, React children
    in the inbox.
  - `splitLinks` exists in both apps, because the widget shares no code with
    the dashboard (ADR-021 §2). Tests pin the same cases in both.
- **Closed conversations:** if an agent closes the conversation while a visitor
  is attaching, the widget moves to the new conversation (ADR-026 §8) and
  uploads the files again there before sending.
- **Inbox composer:** mounted per conversation, so a half-written reply and its
  files never follow the agent into another thread. Enter sends and Shift+Enter
  adds a line, as in the widget.

Link previews (fetching the page behind a URL) are deliberately not built. The
server would have to fetch arbitrary URLs, which is a server-side request
forgery risk, and the benefit is small.

## Consequences

- Both sides can exchange pictures and documents without anyone signing in.
- A file link works for anyone who has it, like a private share link. Rotating
  access means deleting the attachment. There is no per-viewer revocation.
- Files uploaded but never sent stay in GridFS. They are unreachable, because
  downloads require a sent message, but they use space. A periodic sweep of
  unsent attachments older than a day is a follow-up.
- GridFS keeps files in MongoDB. At large volume, moving the bytes to object
  storage changes only `attachment.service.ts`.
