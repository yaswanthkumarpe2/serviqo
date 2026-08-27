import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

import { ACCESS_TOKEN_SECRET_MIN_LENGTH, WIDGET_TOKEN_SECRET_MIN_LENGTH } from "../../config/constants";

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

/**
 * HS256 signing key for access tokens (ADR-011 §11).
 *
 * Required with no default, for the same reason as MONGODB_URI and
 * CLIENT_URL: a fallback would let a process boot and sign real credentials
 * with a key an attacker could guess from the source tree. The minimum
 * length is enforced because HMAC-SHA256's security is bounded by its key.
 *
 * Only the secret lives here. The token's lifetime does not — a misconfigured
 * deployment must not be able to stretch a credential's validity, so
 * ACCESS_TOKEN_TTL_MS is a code constant.
 *
 * The message never echoes the value.
 */
const jwtAccessSecretSchema = z
  .string()
  .min(
    ACCESS_TOKEN_SECRET_MIN_LENGTH,
    `JWT_ACCESS_SECRET must be at least ${ACCESS_TOKEN_SECRET_MIN_LENGTH} characters`,
  );

/**
 * HS256 signing key for widget visitor tokens (ADR-019 §8).
 *
 * A SEPARATE key from JWT_ACCESS_SECRET, and that is the point rather than
 * tidiness. Serviqo issues two credential formats to two principal types, and
 * distinct keys mean a staff token presented to the widget verifier fails at
 * the signature rather than at an audience claim — a control that holds even
 * if a claim check is one day written wrongly.
 *
 * Required with no default, like every other signing key here: a fallback
 * would let a process boot and mint real visitor credentials with a key an
 * attacker could read out of the source tree.
 *
 * The message never echoes the value.
 */
const jwtWidgetSecretSchema = z
  .string()
  .min(
    WIDGET_TOKEN_SECRET_MIN_LENGTH,
    `JWT_WIDGET_SECRET must be at least ${WIDGET_TOKEN_SECRET_MIN_LENGTH} characters`,
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
    CLIENT_URL: clientUrlSchema,
    JWT_ACCESS_SECRET: jwtAccessSecretSchema,
    JWT_WIDGET_SECRET: jwtWidgetSecretSchema,
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  /*
    The two signing keys must differ, enforced at boot rather than documented
    (ADR-019 §8).

    A deployment that set both to one value — by copying a line in a .env, or
    by a secret manager resolving two names to one entry — would have the
    audience claim as its only remaining separation between a visitor
    credential and a staff one. That is a configuration mistake which produces
    no symptom at all until it produces the worst one, so the process refuses
    to start instead.

    Neither value appears in the message.
  */
  .refine((parsed) => parsed.JWT_ACCESS_SECRET !== parsed.JWT_WIDGET_SECRET, {
    path: ["JWT_WIDGET_SECRET"],
    message: "JWT_WIDGET_SECRET must not be the same value as JWT_ACCESS_SECRET",
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
