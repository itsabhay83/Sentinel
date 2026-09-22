import { describe, expect, it } from "vitest";
import {
  ALERT_CHANNEL_KINDS,
  ASSERTION_KINDS,
  ASSERTION_OPERATORS,
  CHECK_INTERVALS,
  INCIDENT_SEVERITIES,
  MONITOR_STATUSES,
  MONITOR_TYPES,
  REGION_HEALTH_STATUSES,
  assertionSchema,
  checkJobSchema,
  checkResultSchema,
  isFailure,
  severityForStatus,
  statusColor,
  statusLabel,
  timingSchema,
  type IncidentSeverity,
  type MonitorStatus,
} from "./monitor";

const MONITOR_ID = "3f7b4b1c-1f4e-4b0c-9a4e-2c3a1b9d7e10";
const CYCLE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const ASSERTION_ID = "11111111-2222-4333-8444-555555555555";

function checkJobInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-1",
    monitorId: MONITOR_ID,
    cycleId: CYCLE_ID,
    regionCode: "fra",
    type: "http",
    url: "https://example.com/health",
    timeoutMs: 10_000,
    followRedirects: true,
    maxRedirects: 3,
    expectedStatusCodes: [200, 204],
    scheduledAt: 1_770_000_000_000,
    ...overrides,
  };
}

describe("checkJobSchema", () => {
  it("fills the defaults a caller may omit", () => {
    const job = checkJobSchema.parse(checkJobInput());

    expect(job.method).toBe("GET");
    expect(job.headersEncrypted).toBeNull();
    expect(job.bodyEncrypted).toBeNull();
    expect(job.flowStepsEncrypted).toBeNull();
    expect(job.assertions).toEqual([]);
  });

  it("carries secrets only as ciphertext fields, never as plaintext ones", () => {
    const job = checkJobSchema.parse(
      checkJobInput({ headersEncrypted: "v1.aa.bb.cc", bodyEncrypted: "v1.dd.ee.ff" }),
    );

    expect(job.headersEncrypted).toBe("v1.aa.bb.cc");
    expect(job).not.toHaveProperty("headers");
    expect(job).not.toHaveProperty("body");
  });

  it("accepts an assertion list", () => {
    const job = checkJobSchema.parse(
      checkJobInput({
        assertions: [
          {
            id: ASSERTION_ID,
            kind: "keyword",
            target: null,
            operator: "contains",
            value: "ok",
            orderIndex: 0,
          },
        ],
      }),
    );

    expect(job.assertions).toHaveLength(1);
    expect(job.assertions[0]?.kind).toBe("keyword");
  });

  it.each([
    ["an unknown region code", { regionCode: "mars" }],
    ["an unknown monitor type", { type: "gopher" }],
    ["a non-uuid monitor id", { monitorId: "not-a-uuid" }],
    ["a non-uuid cycle id", { cycleId: "not-a-uuid" }],
    ["a zero timeout", { timeoutMs: 0 }],
    ["a negative timeout", { timeoutMs: -1 }],
    ["a fractional timeout", { timeoutMs: 10.5 }],
    ["a negative redirect budget", { maxRedirects: -1 }],
    ["a fractional scheduled-at", { scheduledAt: 1.5 }],
    ["a non-array expected-status list", { expectedStatusCodes: 200 }],
  ])("rejects %s", (_label, override) => {
    expect(checkJobSchema.safeParse(checkJobInput(override)).success).toBe(false);
  });

  it("accepts a zero redirect budget, which means 'do not follow'", () => {
    expect(checkJobSchema.parse(checkJobInput({ maxRedirects: 0 })).maxRedirects).toBe(0);
  });
});

describe("assertionSchema", () => {
  it.each(ASSERTION_KINDS)("accepts the %s kind", (kind) => {
    const parsed = assertionSchema.safeParse({
      id: ASSERTION_ID,
      kind,
      target: "$.status",
      operator: "equals",
      value: "ok",
      orderIndex: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it.each(ASSERTION_OPERATORS)("accepts the %s operator", (operator) => {
    const parsed = assertionSchema.safeParse({
      id: ASSERTION_ID,
      kind: "jsonpath",
      target: "$.status",
      operator,
      value: "ok",
      orderIndex: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an operator outside the taxonomy", () => {
    const parsed = assertionSchema.safeParse({
      id: ASSERTION_ID,
      kind: "keyword",
      target: null,
      operator: "approximately",
      value: "ok",
      orderIndex: 0,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("timingSchema", () => {
  it("allows every phase to be null when it never ran", () => {
    const timing = timingSchema.parse({
      dnsMs: null,
      tcpMs: null,
      tlsMs: null,
      ttfbMs: null,
      transferMs: null,
      totalMs: 4,
    });
    expect(timing.dnsMs).toBeNull();
    expect(timing.totalMs).toBe(4);
  });

  it("requires a total, because every attempt took some wall-clock time", () => {
    const parsed = timingSchema.safeParse({
      dnsMs: 1,
      tcpMs: 2,
      tlsMs: 3,
      ttfbMs: 4,
      transferMs: 5,
      totalMs: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("checkResultSchema", () => {
  function resultInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      jobId: "job-1",
      monitorId: MONITOR_ID,
      cycleId: CYCLE_ID,
      regionCode: "iad",
      checkedAt: 1_770_000_000_000,
      ok: true,
      statusCode: 200,
      failureCode: null,
      errorDetail: null,
      timing: { dnsMs: 4, tcpMs: 9, tlsMs: 21, ttfbMs: 88, transferMs: 3, totalMs: 125 },
      responseSizeBytes: 1_024,
      resolvedIp: "93.184.216.34",
      certExpiresAt: 1_800_000_000_000,
      bodySnippet: null,
      responseHeaders: { "content-type": "text/html" },
      ...overrides,
    };
  }

  it("parses a successful result", () => {
    const result = checkResultSchema.parse(resultInput());
    expect(result.ok).toBe(true);
    expect(result.failureCode).toBeNull();
    expect(result.timing.totalMs).toBe(125);
  });

  it("parses a failure carrying a taxonomy code", () => {
    const result = checkResultSchema.parse(
      resultInput({
        ok: false,
        statusCode: null,
        failureCode: "TCP_TIMEOUT",
        errorDetail: "connect ETIMEDOUT",
        resolvedIp: null,
        certExpiresAt: null,
        responseHeaders: null,
        bodySnippet: "upstream timed out",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe("TCP_TIMEOUT");
  });

  it("rejects a failure code outside the taxonomy", () => {
    expect(checkResultSchema.safeParse(resultInput({ failureCode: "KAPUT" })).success).toBe(false);
  });

  it("rejects a header map with non-string values", () => {
    expect(checkResultSchema.safeParse(resultInput({ responseHeaders: { age: 4 } })).success).toBe(
      false,
    );
  });
});

describe("isFailure", () => {
  it("is the negation of ok", () => {
    expect(isFailure({ ok: false })).toBe(true);
    expect(isFailure({ ok: true })).toBe(false);
  });
});

describe("statusColor", () => {
  it.each(MONITOR_STATUSES)("gives %s a hex colour", (status) => {
    expect(statusColor(status)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("gives the three alarming states three distinct colours", () => {
    const alarming = new Set([statusColor("DEGRADED"), statusColor("PARTIAL_OUTAGE"), statusColor("DOWN")]);
    expect(alarming.size).toBe(3);
    expect(alarming.has(statusColor("UP"))).toBe(false);
  });
});

describe("statusLabel", () => {
  it.each(MONITOR_STATUSES)("gives %s a non-empty human label", (status) => {
    expect(statusLabel(status).length).toBeGreaterThan(0);
  });

  it("labels UP as Operational rather than echoing the enum", () => {
    expect(statusLabel("UP")).toBe("Operational");
  });

  it("gives every status a distinct label", () => {
    const labels = new Set(MONITOR_STATUSES.map(statusLabel));
    expect(labels.size).toBe(MONITOR_STATUSES.length);
  });
});

interface SeverityCase {
  readonly status: MonitorStatus;
  readonly expected: IncidentSeverity | null;
}

const SEVERITIES: readonly SeverityCase[] = [
  { status: "DOWN", expected: "down" },
  { status: "PARTIAL_OUTAGE", expected: "partial" },
  { status: "DEGRADED", expected: "degraded" },
  { status: "UP", expected: null },
  { status: "PAUSED", expected: null },
  { status: "INCONCLUSIVE", expected: null },
  { status: "PENDING", expected: null },
];

describe("severityForStatus", () => {
  it.each(SEVERITIES)("maps $status to $expected", ({ status, expected }) => {
    expect(severityForStatus(status)).toBe(expected);
  });

  it("only ever returns a declared severity", () => {
    for (const status of MONITOR_STATUSES) {
      const severity = severityForStatus(status);
      if (severity !== null) {
        expect(INCIDENT_SEVERITIES).toContain(severity);
      }
    }
  });
});

interface EnumTableCase {
  readonly name: string;
  readonly members: readonly string[];
}

const ENUM_TABLES: readonly EnumTableCase[] = [
  { name: "MONITOR_STATUSES", members: MONITOR_STATUSES },
  { name: "MONITOR_TYPES", members: MONITOR_TYPES },
  { name: "INCIDENT_SEVERITIES", members: INCIDENT_SEVERITIES },
  { name: "ASSERTION_KINDS", members: ASSERTION_KINDS },
  { name: "ASSERTION_OPERATORS", members: ASSERTION_OPERATORS },
  { name: "ALERT_CHANNEL_KINDS", members: ALERT_CHANNEL_KINDS },
  { name: "REGION_HEALTH_STATUSES", members: REGION_HEALTH_STATUSES },
];

describe("enum tables", () => {
  it.each(ENUM_TABLES)("$name has no duplicate members", ({ members }) => {
    expect(new Set(members).size).toBe(members.length);
  });

  it.each(ENUM_TABLES)("$name is non-empty and lower-snake free of blanks", ({ members }) => {
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) expect(member.trim()).toBe(member);
  });

  it("offers check intervals that are positive, unique and strictly increasing", () => {
    expect(new Set(CHECK_INTERVALS).size).toBe(CHECK_INTERVALS.length);
    for (let i = 0; i < CHECK_INTERVALS.length; i += 1) {
      const interval = CHECK_INTERVALS[i] ?? 0;
      expect(interval).toBeGreaterThan(0);
      expect(Number.isInteger(interval)).toBe(true);
      if (i > 0) expect(interval).toBeGreaterThan(CHECK_INTERVALS[i - 1] ?? 0);
    }
  });
});
