import { createServer, type Server } from "node:http";
import type IORedis from "ioredis";

import { sql as rawSql } from "@sentinel/db";
import { getProbeEnv } from "@sentinel/shared/env";

import { logger } from "./logger";
import { registry } from "./metrics";
import { isDraining } from "./shutdown";

/**
 * Long enough that a scrape storm or an aggressive load balancer cannot turn
 * `/ready` into a denial-of-service against Postgres, short enough that a real
 * outage is reflected within one probe interval.
 */
const DEPENDENCY_CACHE_MS = 2_000;
const DEPENDENCY_TIMEOUT_MS = 2_000;

interface Readiness {
  postgres: boolean;
  redis: boolean;
  worker: boolean;
}

let cached: { readiness: Readiness; at: number } | null = null;
let inFlight: Promise<Readiness> | null = null;

function withTimeout<T>(work: PromiseLike<T>, fallback: T): Promise<T> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), DEPENDENCY_TIMEOUT_MS).unref();
    }),
  ]);
}

async function probeDependencies(redis: IORedis, workerRunning: boolean): Promise<Readiness> {
  const [postgres, cache] = await Promise.all([
    withTimeout(
      rawSql`SELECT 1`.then(() => true).catch(() => false),
      false,
    ),
    withTimeout(
      redis
        .ping()
        .then((reply) => reply === "PONG")
        .catch(() => false),
      false,
    ),
  ]);
  return { postgres, redis: cache, worker: workerRunning };
}

/** Single-flight plus a short cache: concurrent probes share one round trip. */
async function readiness(redis: IORedis, workerRunning: boolean): Promise<Readiness> {
  if (cached !== null && Date.now() - cached.at < DEPENDENCY_CACHE_MS) {
    return { ...cached.readiness, worker: workerRunning };
  }
  if (inFlight === null) {
    const pending = probeDependencies(redis, workerRunning);
    inFlight = pending;
    void pending
      .then((result) => {
        cached = { readiness: result, at: Date.now() };
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export interface HealthServerOptions {
  readonly port: number;
  readonly region: string;
  readonly redis: IORedis;
  readonly isWorkerRunning: () => boolean;
}

/**
 * `/live` answers whether the process is alive, `/ready` whether it should be
 * handed work. A probe that has lost Postgres is alive but cannot record a
 * result, so restarting it fixes nothing while routing to it does harm.
 */
export function startHealthServer(options: HealthServerOptions): Server {
  const server = createServer((request, response) => {
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    const url = request.url ?? "/";
    const draining = isDraining();

    if (url === "/live") {
      send(draining ? 503 : 200, { service: "probe", region: options.region, draining });
      return;
    }

    if (url === "/ready") {
      if (draining) {
        send(503, { service: "probe", region: options.region, draining, ready: false });
        return;
      }
      void readiness(options.redis, options.isWorkerRunning()).then((deps) => {
        const ready = deps.postgres && deps.redis && deps.worker;
        send(ready ? 200 : 503, {
          service: "probe",
          region: options.region,
          ready,
          dependencies: deps,
        });
      });
      return;
    }

    if (url === "/metrics") {
      if (!getProbeEnv().METRICS_ENABLED) {
        send(404, { error: "metrics disabled" });
        return;
      }
      void registry
        .metrics()
        .then((body) => {
          response.writeHead(200, { "content-type": registry.contentType });
          response.end(body);
        })
        .catch((error: unknown) => {
          logger.error({ err: error }, "metrics collection failed");
          send(500, { error: "metrics collection failed" });
        });
      return;
    }

    send(404, { error: "not found" });
  });

  server.listen(options.port, () => {
    logger.info({ port: options.port }, "health and metrics endpoints listening");
  });
  return server;
}
