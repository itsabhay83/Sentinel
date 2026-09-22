import { createServer, type Server } from "node:http";
import type IORedis from "ioredis";

import { sql as rawSql } from "@sentinel/db";
import { getServerEnv } from "@sentinel/shared/env";

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

async function probeDependencies(redis: IORedis): Promise<Readiness> {
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
  return { postgres, redis: cache };
}

/** Single-flight plus a short cache: concurrent probes share one round trip. */
async function readiness(redis: IORedis): Promise<Readiness> {
  if (cached !== null && Date.now() - cached.at < DEPENDENCY_CACHE_MS) {
    return cached.readiness;
  }
  if (inFlight === null) {
    const pending = probeDependencies(redis);
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
  readonly redis: IORedis;
  readonly isLeader: () => boolean;
}

function send(
  respond: (status: number, body: string, contentType: string) => void,
  status: number,
  payload: unknown,
): void {
  respond(status, JSON.stringify(payload), "application/json");
}

/**
 * `/live` answers whether the process is alive, `/ready` whether it should
 * receive work. They are split because a scheduler that has lost Postgres is
 * alive but useless: restarting it fixes nothing, while routing to it does harm.
 */
export function startHealthServer(options: HealthServerOptions): Server {
  const server = createServer((request, response) => {
    const respond = (status: number, body: string, contentType: string): void => {
      response.writeHead(status, { "content-type": contentType });
      response.end(body);
    };

    const url = request.url ?? "/";
    const draining = isDraining();

    if (url === "/live") {
      send(respond, draining ? 503 : 200, { service: "scheduler", draining });
      return;
    }

    if (url === "/ready") {
      if (draining) {
        send(respond, 503, { service: "scheduler", draining, ready: false });
        return;
      }
      void readiness(options.redis).then((deps) => {
        const ready = deps.postgres && deps.redis;
        send(respond, ready ? 200 : 503, {
          service: "scheduler",
          ready,
          leader: options.isLeader(),
          dependencies: deps,
        });
      });
      return;
    }

    if (url === "/metrics") {
      if (!getServerEnv().METRICS_ENABLED) {
        send(respond, 404, { error: "metrics disabled" });
        return;
      }
      void registry
        .metrics()
        .then((body) => respond(200, body, registry.contentType))
        .catch((error: unknown) => {
          logger.error({ err: error }, "metrics collection failed");
          send(respond, 500, { error: "metrics collection failed" });
        });
      return;
    }

    send(respond, 404, { error: "not found" });
  });

  server.listen(options.port, () => {
    logger.info({ port: options.port }, "health and metrics endpoints listening");
  });
  return server;
}
