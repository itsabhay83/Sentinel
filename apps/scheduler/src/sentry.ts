import { getServerEnv } from "@sentinel/shared/env";

import { logger } from "./logger";

/**
 * Sentry is loaded through a dynamic import so an empty DSN costs nothing at
 * all: the SDK and its OpenTelemetry dependency tree are never evaluated, no
 * transport is created, and `captureError` degrades to a no-op.
 */
type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | null = null;

export async function initSentry(): Promise<void> {
  const env = getServerEnv();
  if (env.SENTRY_DSN.length === 0) return;
  const module = await import("@sentry/node");
  module.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0,
  });
  sentry = module;
  logger.info("sentry reporting enabled");
}

export function captureError(error: unknown, context: Record<string, unknown> = {}): void {
  sentry?.captureException(error, { extra: context });
}

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!sentry) return;
  await sentry.flush(timeoutMs).catch(() => undefined);
}
