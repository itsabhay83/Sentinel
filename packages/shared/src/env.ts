import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * Environment loading and validation. Boot fails loudly and specifically when
 * anything is missing or malformed — no service ever starts half-configured.
 *
 * A single `.env` lives at the repo root and is shared by every workspace
 * package, so there is exactly one place to configure the system.
 */

function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Minimal dotenv parser — avoids a dependency for a 20-line job. */
function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let dotenvLoaded = false;

/** Loads the root `.env` into process.env without overwriting real env vars. */
export function loadRootEnv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const root = findRepoRoot(process.cwd());
  if (!root) return;
  for (const file of [".env.local", ".env"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const parsed = parseDotenv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/**
 * `z.coerce.boolean()` treats every non-empty string as true, which would make
 * `FLAG=false` mean true. This accepts the spellings people actually write.
 */
function booleanish(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === "boolean") return value;
      const normalised = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalised)) return true;
      if (["0", "false", "no", "off", ""].includes(normalised)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a boolean (true/false/1/0/yes/no/on/off), received "${value}"`,
      });
      return z.NEVER;
    });
}

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    }),

  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL is required")
    .refine((v) => v.startsWith("redis://") || v.startsWith("rediss://"), {
      message: "REDIS_URL must be a redis:// or rediss:// connection string",
    }),

  ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256-GCM)",
    ),

  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
  NEXT_PUBLIC_APP_URL: z.string().url("NEXT_PUBLIC_APP_URL must be a valid URL"),

  RESEND_API_KEY: z.string().default(""),
  ALERT_EMAIL_FROM: z.string().default("Sentinel <alerts@example.com>"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  SCHEDULER_HEALTH_PORT: z.coerce.number().int().positive().default(4000),
  PROBE_HEALTH_PORT: z.coerce.number().int().min(0).default(0),

  API_KEY_HMAC_SECRET: z.string().default(""),

  DB_POOL_MAX: z.coerce.number().int().min(0).max(200).default(0),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  RATE_LIMIT_ENABLED: booleanish(true),

  SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(0).default(10_080),

  REQUIRE_EMAIL_VERIFICATION: booleanish(true),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().positive().default(1_440),
  MFA_ISSUER: z.string().min(1).default("Sentinel"),

  ALERT_MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
  CHECK_JOB_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  QUEUE_MAX_DEPTH: z.coerce.number().int().positive().default(20_000),

  METRICS_ENABLED: booleanish(true),
  SENTRY_DSN: z.string().default(""),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

const probeEnvSchema = serverEnvSchema.extend({
  REGION_CODE: z.string().min(2, "REGION_CODE is required for a probe process"),
  PROBE_CONCURRENCY: z.coerce.number().int().positive().default(10),
});

/**
 * Derived rather than configured so a fresh checkout has no third mandatory
 * secret, and — critically — so no HMAC key is ever hardcoded in source.
 * Domain-separated from BETTER_AUTH_SECRET so leaking one hash space tells an
 * attacker nothing about the other.
 */
function resolveApiKeyHmacSecret(env: { API_KEY_HMAC_SECRET: string; BETTER_AUTH_SECRET: string }): string {
  if (env.API_KEY_HMAC_SECRET.length > 0) return env.API_KEY_HMAC_SECRET;
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update("sentinel:api-key-hmac:v1").digest("hex");
}

export type ProbeEnv = z.infer<typeof probeEnvSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

let cachedServerEnv: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;
  loadRootEnv();
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment. Fix your .env (copy .env.example if you have not):\n${formatIssues(parsed.error)}`,
    );
  }
  cachedServerEnv = {
    ...parsed.data,
    API_KEY_HMAC_SECRET: resolveApiKeyHmacSecret(parsed.data),
  };
  return cachedServerEnv;
}

let cachedProbeEnv: ProbeEnv | null = null;

export function getProbeEnv(): ProbeEnv {
  if (cachedProbeEnv) return cachedProbeEnv;
  loadRootEnv();
  const parsed = probeEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid probe environment:\n${formatIssues(parsed.error)}`,
    );
  }
  cachedProbeEnv = {
    ...parsed.data,
    API_KEY_HMAC_SECRET: resolveApiKeyHmacSecret(parsed.data),
  };
  return cachedProbeEnv;
}
