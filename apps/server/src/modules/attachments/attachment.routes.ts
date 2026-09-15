import express, { Router } from "express";

import { ATTACHMENT_MAX_BYTES } from "../../config/constants";
import { attachmentService } from "./attachment.service";
import { allowedTypeFor } from "./fileTypes";

import type { RequestHandler } from "express";

/**
 * Reads an upload's raw bytes (ADR-041 §2).
 *
 * The file is the whole request body, its type is `Content-Type`, and its name
 * travels URI-encoded in `X-Filename`. No multipart parser: one file per
 * request needs none, and there is no parser to misconfigure.
 *
 * Mounted AFTER authentication and the rate limiter on each upload route, so an
 * anonymous or refused caller never makes the server buffer ten megabytes.
 */
export const readUploadBody: RequestHandler = express.raw({
  type: () => true,
  limit: ATTACHMENT_MAX_BYTES,
});

export function uploadedFileFrom(req: Parameters<RequestHandler>[0]) {
  return {
    contentType: req.get("content-type"),
    fileName: req.get("x-filename"),
    bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
  };
}

/** `inline; filename="…"; filename*=UTF-8''…` with an ASCII fallback. */
function contentDisposition(inline: boolean, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * `GET /api/v1/files/:attachmentId/:fileName?key=…`: the download link for a
 * file sent in a chat (ADR-041 §3).
 *
 * Public by path, private by key. An `<img>` cannot send a bearer token, so the
 * 256-bit key in the link is the credential, and only people who can read the
 * message ever see it. Wrong id, wrong key and unsent file all get one 404.
 */
export function createFileRouter(): Router {
  const router = Router();

  const download: RequestHandler = async (req, res) => {
    const attachment = await attachmentService.findForDownload(String(req.params.attachmentId), req.query.key);
    const inline = allowedTypeFor(attachment.contentType)?.inline ?? false;

    res.setHeader(
      "Content-Type",
      attachment.contentType === "text/plain" ? "text/plain; charset=utf-8" : attachment.contentType,
    );
    res.setHeader("Content-Length", String(attachment.size));
    res.setHeader("Content-Disposition", contentDisposition(inline, attachment.name));
    // The widget shows images on the customer's own site, a different origin.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Even if a browser rendered the file as a document, it could run nothing.
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    // The bytes behind an id never change.
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");

    const stream = attachmentService.openDownloadStream(attachment.fileId);
    stream.on("error", (err) => {
      req.log.error({ event: "attachment.download_failed", attachmentId: attachment._id.toString(), err: err.name }, "File stream failed");
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    stream.pipe(res);
  };

  router.get("/:attachmentId{/:fileName}", download);

  return router;
}
