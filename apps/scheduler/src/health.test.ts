import { once } from "node:events";
import type { Server } from "node:http";
import type IORedis from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Dependencies {
  postgresReachable: boolean;
  redisReply: string;
  draining: boolean;
  postgresProbes: number;
}

const deps = vi.hoisted(
  (): Dependencies => ({
    postgresReachable: true,
    redisReply: "PONG",
    draining: false,
    postgresProbes: 0,
  }),
);

vi.mock("@sentinel/db", () => ({
  sql: (): Promise<unknown[]> => {
    deps.postgresProbes += 1;
    return deps.postgresReachable
      ? Promise.resolve([{ ok: 1 }])
      : Promise.reject(new Error("no route to host"));
  },
}));

/** `draining` is a module-level flag only a real SIGTERM can flip. */
vi.mock("./shutdown", () => ({ isDraining: (): boolean => deps.draining }));

/**
 * `startHealthServer` only ever calls `ping()`. The conversion is confined here
 * so the fake stays honest about what it models.
 */
const fakeRedis = {
  ping: (): Promise<string> => Promise.resolve(deps.redisReply),
} as unknown as IORedis;

let server: Server | null = null;

async function start(isLeader = true): Promise<string> {
  // A fresh module per test: health.ts caches readiness for two seconds, and a
  // shared cache would make these tests depend on each other's timing.
  vi.resetModules();
  const { startHealthServer } = await import("./health");
  server = startHealthServer({ port: 0, redis: fakeRedis, isLeader: () => isLeader });
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind a port");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  deps.postgresReachable = true;
  deps.redisReply = "PONG";
  deps.draining = false;
  deps.postgresProbes = 0;
});

afterEach(async () => {
  const running = server;
  server = null;
  if (running === null) return;
  running.close();
  await once(running, "close");
});

describe("GET /live", () => {
  it("answers 200 while the process is alive", async () => {
    const base = await start();

    const response = await fetch(`${base}/live`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "scheduler", draining: false });
  });

  it("answers 503 from the instant SIGTERM lands", async () => {
    deps.draining = true;
    const base = await start();

    const response = await fetch(`${base}/live`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ service: "scheduler", draining: true });
  });
});

describe("GET /ready", () => {
  it("answers 200 with both dependencies healthy", async () => {
    const base = await start();

    const response = await fetch(`${base}/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "scheduler",
      ready: true,
      leader: true,
      dependencies: { postgres: true, redis: true },
    });
  });

  it("reports leadership without letting it gate readiness", async () => {
    // A follower is perfectly able to serve; only the dependencies decide.
    const base = await start(false);

    const response = await fetch(`${base}/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ready: true, leader: false });
  });

  it("answers 503 and names Postgres when the query fails", async () => {
    deps.postgresReachable = false;
    const base = await start();

    const response = await fetch(`${base}/ready`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      dependencies: { postgres: false, redis: true },
    });
  });

  it("treats a reply that is not PONG as Redis being unhealthy", async () => {
    deps.redisReply = "LOADING";
    const base = await start();

    const response = await fetch(`${base}/ready`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      dependencies: { postgres: true, redis: false },
    });
  });

  it("fails before probing anything once draining", async () => {
    deps.draining = true;
    const base = await start();

    const response = await fetch(`${base}/ready`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      service: "scheduler",
      draining: true,
      ready: false,
    });
    expect(deps.postgresProbes).toBe(0);
  });

  it("shares one round trip across a burst of scrapes", async () => {
    // Without the cache an aggressive load balancer turns /ready into a denial
    // of service against Postgres.
    const base = await start();

    const responses = await Promise.all([
      fetch(`${base}/ready`),
      fetch(`${base}/ready`),
      fetch(`${base}/ready`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(deps.postgresProbes).toBe(1);
    await Promise.all(responses.map((response) => response.text()));
  });
});

describe("GET /metrics", () => {
  it("serves the Prometheus exposition format", async () => {
    const base = await start();

    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toContain("sentinel_tick_duration_seconds");
  });
});

describe("any other path", () => {
  it.each(["/", "/healthz", "/live/", "/metrics?format=json"])(
    "answers 404 for %s rather than guessing",
    async (path) => {
      const base = await start();

      const response = await fetch(`${base}${path}`);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not found" });
    },
  );
});
