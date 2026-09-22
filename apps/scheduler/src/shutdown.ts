import { logger } from "./logger";
import { captureError, flushSentry } from "./sentry";

let draining = false;

/** True from the instant SIGTERM lands, so `/ready` fails before the drain starts. */
export const isDraining = (): boolean => draining;

export interface ShutdownOptions {
  /** Must stay under the orchestrator's stop_grace_period. */
  readonly graceMs: number;
  readonly drain: () => Promise<void>;
}

/**
 * Installs signal and last-resort process handlers.
 *
 * The watchdog is the important half: a drain that hangs gets SIGKILLed with no
 * explanation, whereas a forced exit at a known deadline leaves a log line
 * naming the budget it blew. It is unref'd so a clean drain still lets the
 * event loop empty naturally.
 */
export function installShutdownHandlers(options: ShutdownOptions): void {
  const run = async (signal: string): Promise<void> => {
    if (draining) return;
    draining = true;
    logger.info({ signal, graceMs: options.graceMs }, "draining");

    const watchdog = setTimeout(() => {
      logger.error(
        { signal, graceMs: options.graceMs },
        "graceful shutdown exceeded its budget; forcing exit",
      );
      process.exit(1);
    }, options.graceMs);
    watchdog.unref();

    try {
      await options.drain();
    } catch (error) {
      captureError(error, { phase: "shutdown" });
      logger.error({ signal, err: error }, "shutdown drain failed");
      await flushSentry();
      process.exit(1);
    }

    clearTimeout(watchdog);
    await flushSentry();
    logger.info({ signal }, "shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void run("SIGINT"));
  process.on("SIGTERM", () => void run("SIGTERM"));

  const die = (error: unknown, phase: string, extra: Record<string, unknown> = {}): void => {
    captureError(error, { phase, ...extra });
    logger.fatal({ err: error, phase, draining, ...extra }, "fatal error; exiting");
    void flushSentry(1_000).finally(() => process.exit(1));
  };

  process.on("unhandledRejection", (reason) => die(reason, "unhandledRejection"));
  process.on("uncaughtException", (error, origin) => die(error, "uncaughtException", { origin }));
}
