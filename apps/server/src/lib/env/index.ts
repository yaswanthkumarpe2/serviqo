import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

/**
 * Loaded once from the monorepo root .env — shared with apps/web rather
 * than a per-workspace file. dotenv never overwrites an already-set
 * process.env value, so tests that set process.env.* before this module
 * is imported (see tests/setup.ts) take precedence over the file.
 */
dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });

/**
 * Origin of the web client, used to build the links emailed to users.
 *
 * Required with no default, exactly like MONGODB_URI: a wrong value mails
 * live 24-hour credentials to the wrong origin, so a permissive fallback
 * would be a silent security failure rather than a convenience (ADR-007 §9).
 *
 * Query strings and fragments are rejected because the verification link
 * appends its own `?token=` — a base URL carrying either would produce a
 * malformed or ambiguous link. Trailing slashes are stripped so URL joining
 * is deterministic regardless of how the value was written.
 *
 * Messages never echo the offending value; a misconfigured URL can still
 * contain something its operator would not want in a crash log.
 */
const clientUrlSchema = z
  .string()
  .min(1, "CLIENT_URL is required")
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "CLIENT_URL must be a valid absolute URL" });
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "CLIENT_URL must use http or https" });
    }
    if (url.search) {
      ctx.addIssue({ code: "custom", message: "CLIENT_URL must not contain a query string" });
    }
    if (url.hash) {
      ctx.addIssue({ code: "custom", message: "CLIENT_URL must not contain a fragment" });
    }
  })
  .transform((value) => value.replace(/\/+$/, ""));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  CLIENT_URL: clientUrlSchema,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
