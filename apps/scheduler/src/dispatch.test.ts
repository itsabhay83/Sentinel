import type IORedis from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckJob } from "@sentinel/shared";
import { decryptJson } from "@sentinel/shared/server";

import type { ClaimedMonitor } from "./claim";
import { dispatchBackpressure, queueDepth } from "./metrics";

interface BulkEntry {
  readonly queue: string;
  readonly name: string;
  readonly data: CheckJob;
  readonly opts: { readonly jobId: string; readonly attempts: number };
}

interface QueueState {
  waiting: number;
  delayed: number;
  readonly created: string[];
  readonly added: BulkEntry[];
  closed: number;
}

const queues = vi.hoisted(
  (): QueueState => ({
    waiting: 0,
    delayed: 0,
    created: [],
    added: [],
    closed: 0,
  }),
);

const dbState = vi.hoisted((): { claimed: readonly ClaimedMonitor[] } => ({ claimed: [] }));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(private readonly queueName: string) {
      queues.created.push(queueName);
    }
    getJobCounts(): Promise<Record<string, number>> {
      return Promise.resolve({ waiting: queues.waiting, delayed: queues.delayed });
    }
    addBulk(entries: readonly Omit<BulkEntry, "queue">[]): Promise<unknown[]> {
      for (const entry of entries) queues.added.push({ ...entry, queue: this.queueName });
      return Promise.resolve([]);
    }
    close(): Promise<void> {
      queues.closed += 1;
      return Promise.resolve();
    }
  },
}));

vi.mock("@sentinel/db", () => ({
  sql: (strings: TemplateStringsArray): Promise<unknown[]> =>
    Promise.resolve(strings.join("?").includes("WITH due AS") ? [...dbState.claimed] : []),
  withDbRetry: <T>(operation: () => Promise<T>): Promise<T> => operation(),
}));

const { Dispatcher } = await import("./dispatch");

/** The dispatcher only hands this to BullMQ's Queue constructor. */
const fakeRedis = {} as unknown as IORedis;

const KEY = "0".repeat(64);
/** Mirrors QUEUE_MAX_DEPTH pinned in vitest.config.ts. */
const MAX_DEPTH = 10;

const NOW = new Date("2026-03-15T12:00:00.000Z");

function claimed(overrides: Partial<ClaimedMonitor> = {}): ClaimedMonitor {
  return {
    monitor_id: "mon-1",
    cycle_id: "cyc-1",
    type: "http",
    url: "https://api.example.test/checkout",
    method: "GET",
    headers_encrypted: null,
    body_encrypted: null,
    timeout_ms: 10_000,
    follow_redirects: true,
    max_redirects: 5,
    expected_status_codes: [200],
    regions: ["bom", "fra"],
    assertions: null,
    flow_steps: null,
    ...overrides,
  };
}

beforeEach(() => {
  queues.waiting = 0;
  queues.delayed = 0;
  queues.created.length = 0;
  queues.added.length = 0;
  queues.closed = 0;
  dbState.claimed = [];
  dispatchBackpressure.reset();
  queueDepth.reset();
});

describe("Dispatcher fanning a cycle out", () => {
  it("enqueues nothing and touches no queue when nothing is due", async () => {
    await expect(new Dispatcher(fakeRedis).dispatchDue(NOW)).resolves.toBe(0);
    expect(queues.created).toEqual([]);
  });

  it("puts one job on each of the monitor's regional queues", async () => {
    dbState.claimed = [claimed()];

    await expect(new Dispatcher(fakeRedis).dispatchDue(NOW)).resolves.toBe(2);

    expect(queues.created).toEqual(["checks-bom", "checks-fra"]);
    expect(queues.added.map((entry) => entry.data.regionCode)).toEqual(["bom", "fra"]);
  });

  it("reuses one queue object per region across monitors", async () => {
    dbState.claimed = [claimed({ monitor_id: "mon-1" }), claimed({ monitor_id: "mon-2" })];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    expect(queues.created).toEqual(["checks-bom", "checks-fra"]);
    expect(queues.added).toHaveLength(4);
  });

  it("drops a region code the fleet does not recognise", async () => {
    dbState.claimed = [claimed({ regions: ["bom", "atlantis"] })];

    await expect(new Dispatcher(fakeRedis).dispatchDue(NOW)).resolves.toBe(1);
    expect(queues.created).toEqual(["checks-bom"]);
  });

  it.each([
    ["an empty region list", []],
    ["a null region list", null],
    ["only unknown regions", ["atlantis"]],
  ])("skips a monitor with %s rather than enqueuing nothing", async (_label, regions) => {
    dbState.claimed = [claimed({ regions })];

    await expect(new Dispatcher(fakeRedis).dispatchDue(NOW)).resolves.toBe(0);
    expect(queues.added).toEqual([]);
  });
});

describe("the job a probe receives", () => {
  it("separates the cycle and region with an underscore, which BullMQ accepts", async () => {
    // A colon would collide with the key namespace BullMQ composes itself, and
    // is rejected at construction time.
    dbState.claimed = [claimed({ regions: ["bom"] })];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    expect(queues.added[0]?.data.jobId).toBe("cyc-1_bom");
    expect(queues.added[0]?.opts.jobId).toBe("cyc-1_bom");
  });

  it("carries the monitor's request shape and the dispatch instant", async () => {
    dbState.claimed = [claimed({ regions: ["bom"] })];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    expect(queues.added[0]?.data).toMatchObject({
      monitorId: "mon-1",
      cycleId: "cyc-1",
      type: "http",
      url: "https://api.example.test/checkout",
      timeoutMs: 10_000,
      followRedirects: true,
      maxRedirects: 5,
      expectedStatusCodes: [200],
      scheduledAt: NOW.getTime(),
    });
  });

  it("passes monitor ciphertext through without ever decrypting it", async () => {
    dbState.claimed = [
      claimed({ regions: ["bom"], headers_encrypted: "ct-headers", body_encrypted: "ct-body" }),
    ];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    expect(queues.added[0]?.data.headersEncrypted).toBe("ct-headers");
    expect(queues.added[0]?.data.bodyEncrypted).toBe("ct-body");
  });

  it("re-wraps per-step flow secrets into a single envelope", async () => {
    dbState.claimed = [
      claimed({
        regions: ["bom"],
        flow_steps: [
          {
            name: "login",
            url: "https://api.example.test/login",
            method: "POST",
            headersEncrypted: null,
            bodyEncrypted: null,
            expectedStatusCodes: null,
            extract: null,
          },
        ],
      }),
    ];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    const envelope = queues.added[0]?.data.flowStepsEncrypted ?? null;
    expect(envelope).not.toBeNull();
    expect(decryptJson<{ name: string }[]>(envelope, KEY, [])[0]?.name).toBe("login");
  });

  it("substitutes empty lists for a monitor with no assertions or status codes", async () => {
    dbState.claimed = [
      claimed({ regions: ["bom"], assertions: null, expected_status_codes: null }),
    ];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    expect(queues.added[0]?.data.assertions).toEqual([]);
    expect(queues.added[0]?.data.expectedStatusCodes).toEqual([]);
  });

  it("gives the job the configured retry budget", async () => {
    dbState.claimed = [claimed({ regions: ["bom"] })];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    expect(queues.added[0]?.opts.attempts).toBe(3);
  });
});

describe("Dispatcher backpressure", () => {
  it("enqueues normally while the queue is exactly at the limit", async () => {
    queues.waiting = MAX_DEPTH;
    dbState.claimed = [claimed({ regions: ["bom"] })];

    await expect(new Dispatcher(fakeRedis).dispatchDue(NOW)).resolves.toBe(1);
  });

  it("drops the tick once the queue is over the limit", async () => {
    // next_run_at has already advanced, so the next cycle dispatches normally —
    // whereas letting an unconsumed queue grow turns a stalled probe into a
    // Redis outage.
    queues.waiting = MAX_DEPTH;
    queues.delayed = 1;
    dbState.claimed = [claimed({ regions: ["bom"] })];

    await expect(new Dispatcher(fakeRedis).dispatchDue(NOW)).resolves.toBe(0);
    expect(queues.added).toEqual([]);
  });

  it("counts the skip against the region so it is visible in Prometheus", async () => {
    queues.waiting = MAX_DEPTH + 5;
    dbState.claimed = [claimed({ regions: ["bom"] })];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    const metric = await dispatchBackpressure.get();
    expect(metric.values.find((value) => value.labels["region"] === "bom")?.value).toBe(1);
  });

  it("counts waiting plus delayed, because active jobs already belong to a probe", async () => {
    queues.waiting = 4;
    queues.delayed = 3;
    dbState.claimed = [claimed({ regions: ["bom"] })];

    await new Dispatcher(fakeRedis).dispatchDue(NOW);

    const metric = await queueDepth.get();
    expect(metric.values.find((value) => value.labels["region"] === "bom")?.value).toBe(7);
  });
});

describe("Dispatcher shutdown", () => {
  it("closes every queue it opened", async () => {
    dbState.claimed = [claimed()];
    const dispatcher = new Dispatcher(fakeRedis);
    await dispatcher.dispatchDue(NOW);

    await dispatcher.close();

    expect(queues.closed).toBe(2);
  });

  it("closes cleanly when it never opened a queue", async () => {
    await expect(new Dispatcher(fakeRedis).close()).resolves.toBeUndefined();
  });
});
