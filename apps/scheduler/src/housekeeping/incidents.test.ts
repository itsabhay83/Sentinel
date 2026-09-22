import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { incidentsOpened } from "../metrics";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A plain SELECT of timestamptz, so postgres.js really does hand back Dates. */
interface CertRow {
  readonly monitor_id: string;
  readonly monitor_name: string;
  readonly host: string;
  readonly cert_expires_at: Date | null;
  readonly domain_expires_at: Date | null;
  readonly last_alerted_day_bucket: number | null;
}

interface DbState {
  liveToken: string;
  certificates: readonly CertRow[];
  newIncidentId: string | null;
  readonly queries: Recorded[];
}

const db = vi.hoisted(
  (): DbState => ({
    liveToken: "7",
    certificates: [],
    newIncidentId: "inc-new",
    queries: [],
  }),
);

vi.mock("@sentinel/db", () => {
  const route = (text: string): unknown[] => {
    if (text.includes("scheduler_leadership")) {
      return [{ token: db.liveToken, holder_id: "scheduler-a" }];
    }
    if (text.includes("monitor_certificates mc")) return [...db.certificates];
    if (text.includes("INSERT INTO incidents")) {
      return db.newIncidentId === null ? [] : [{ id: db.newIncidentId }];
    }
    return [];
  };
  const record = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    db.queries.push({ text, values });
    return Promise.resolve(route(text));
  };
  const sql = Object.assign(record, {
    begin: (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(record),
  });
  return { sql };
});

const { checkCertificateExpiry } = await import("./incidents");

const FENCE = { token: 7, holderId: "scheduler-a" } as const;
const NOW = new Date("2026-03-15T00:00:00.000Z");

function inDays(days: number): Date {
  return new Date(NOW.getTime() + days * 86_400_000);
}

function certificate(overrides: Partial<CertRow> = {}): CertRow {
  return {
    monitor_id: "mon-1",
    monitor_name: "API — checkout",
    host: "api.example.test",
    cert_expires_at: inDays(20),
    domain_expires_at: null,
    last_alerted_day_bucket: null,
    ...overrides,
  };
}

function queriesMatching(fragment: string): Recorded[] {
  return db.queries.filter((query) => query.text.includes(fragment));
}

function recordedTier(): unknown {
  return queriesMatching("UPDATE monitor_certificates")[0]?.values[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db.liveToken = "7";
  db.certificates = [];
  db.newIncidentId = "inc-new";
  db.queries.length = 0;
  incidentsOpened.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkCertificateExpiry tier selection", () => {
  it.each([
    ["30 days out", 30, 30],
    ["20 days out", 20, 30],
    ["exactly 14 days out", 14, 14],
    ["10 days out", 10, 14],
    ["exactly 7 days out", 7, 7],
    ["3 days out", 3, 7],
    ["1 day out", 1, 1],
    ["expiring today", 0, 1],
    ["already expired", -5, 1],
  ])("alerts %s at the tightest tier crossed", async (_label, daysOut, expectedTier) => {
    db.certificates = [certificate({ cert_expires_at: inDays(daysOut) })];

    await expect(checkCertificateExpiry(FENCE)).resolves.toBe(1);
    expect(recordedTier()).toBe(expectedTier);
  });

  it.each([
    ["31 days out", 31],
    ["a year out", 365],
  ])("stays quiet %s", async (_label, daysOut) => {
    db.certificates = [certificate({ cert_expires_at: inDays(daysOut) })];

    await expect(checkCertificateExpiry(FENCE)).resolves.toBe(0);
    expect(queriesMatching("INSERT INTO incidents")).toEqual([]);
  });

  it("ignores a row with neither expiry recorded", async () => {
    db.certificates = [certificate({ cert_expires_at: null, domain_expires_at: null })];

    await expect(checkCertificateExpiry(FENCE)).resolves.toBe(0);
  });
});

describe("checkCertificateExpiry firing once per tier", () => {
  it.each([
    ["the same tier was already alerted", 20, 30],
    ["a tighter tier was already alerted", 20, 7],
  ])("stays quiet when %s", async (_label, daysOut, previous) => {
    db.certificates = [
      certificate({ cert_expires_at: inDays(daysOut), last_alerted_day_bucket: previous }),
    ];

    await expect(checkCertificateExpiry(FENCE)).resolves.toBe(0);
  });

  it("escalates once the certificate crosses into a tighter tier", async () => {
    db.certificates = [
      certificate({ cert_expires_at: inDays(5), last_alerted_day_bucket: 30 }),
    ];

    await expect(checkCertificateExpiry(FENCE)).resolves.toBe(1);
    expect(recordedTier()).toBe(7);
  });

  it("walks the whole ladder as the expiry approaches", async () => {
    const tiers: unknown[] = [];
    for (const daysOut of [20, 10, 3, 0]) {
      db.queries.length = 0;
      db.certificates = [
        certificate({
          cert_expires_at: inDays(daysOut),
          last_alerted_day_bucket: typeof tiers.at(-1) === "number" ? Number(tiers.at(-1)) : null,
        }),
      ];
      await checkCertificateExpiry(FENCE);
      tiers.push(recordedTier());
    }

    expect(tiers).toEqual([30, 14, 7, 1]);
  });
});

describe("checkCertificateExpiry incident content", () => {
  it("judges by whichever of the two expiries lands first", async () => {
    db.certificates = [
      certificate({ cert_expires_at: inDays(25), domain_expires_at: inDays(3) }),
    ];

    await checkCertificateExpiry(FENCE);

    expect(queriesMatching("INSERT INTO incidents")[0]?.values).toContain("DOMAIN_EXPIRING");
    expect(String(queriesMatching("INSERT INTO incident_events")[0]?.values[1])).toContain(
      "Domain registration for api.example.test expires in 3 day(s)",
    );
  });

  it("names the certificate when it is the sooner of the two", async () => {
    db.certificates = [
      certificate({ cert_expires_at: inDays(3), domain_expires_at: inDays(25) }),
    ];

    await checkCertificateExpiry(FENCE);

    expect(queriesMatching("INSERT INTO incidents")[0]?.values).toContain("CERT_EXPIRING");
    expect(String(queriesMatching("INSERT INTO incident_events")[0]?.values[1])).toContain(
      "TLS certificate for api.example.test",
    );
  });

  it("opens a degraded incident and queues its page", async () => {
    db.certificates = [certificate()];

    await checkCertificateExpiry(FENCE);

    expect(queriesMatching("INSERT INTO alert_deliveries")[0]?.values).toContain("open");
    const metric = await incidentsOpened.get();
    expect(metric.values.find((value) => value.labels["severity"] === "degraded")?.value).toBe(1);
  });

  it("does not record a tier when the incident INSERT returned nothing", async () => {
    db.newIncidentId = null;
    db.certificates = [certificate()];

    await expect(checkCertificateExpiry(FENCE)).resolves.toBe(0);
    expect(queriesMatching("UPDATE monitor_certificates")).toEqual([]);
  });
});

describe("checkCertificateExpiry under a lost fence", () => {
  it("abandons the whole sweep rather than pressing on without leadership", async () => {
    db.liveToken = "8";
    db.certificates = [
      certificate({ monitor_id: "mon-1" }),
      certificate({ monitor_id: "mon-2" }),
    ];

    await expect(checkCertificateExpiry(FENCE)).resolves.toBe(0);
    expect(queriesMatching("INSERT INTO incidents")).toEqual([]);
    expect(queriesMatching("scheduler_leadership")).toHaveLength(1);
  });
});
