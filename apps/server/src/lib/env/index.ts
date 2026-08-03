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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
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
