import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deliver, postEmail, toIso, type PendingDelivery } from "./transports";

interface FetchCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

const calls: FetchCall[] = [];
let nextResponse: () => Response = () => new Response("ok", { status: 200 });

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Promise.resolve(nextResponse());
    }),
  );
}

/**
 * postgres.js skips its timestamptz parser for scalar subqueries in a RETURNING
 * clause, so these two arrive as strings even though the column is timestamptz.
 * transports.ts documents this and reads them through `toIso`.
 */
function delivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: "del-1",
    kind: "open",
    step_index: 0,
    attempts: 0,
    channel_kind: "webhook",
    channel_name: "ops",
    config: { url: "https://hooks.example.test/sentinel" },
    incident_id: "inc-1",
    severity: "down",
    started_at: "2026-03-15T12:00:00.000Z",
    resolved_at: null,
    primary_failure_code: "HTTP_5XX",
    affected_regions: ["bom", "fra"],
    monitor_id: "mon-1",
    monitor_name: "API — checkout",
    monitor_url: "https://api.example.test/checkout",
    ...overrides,
  };
}

function bodyOf(index = 0): unknown {
  return JSON.parse(calls[index]?.body ?? "null");
}

beforeEach(() => {
  calls.length = 0;
  nextResponse = () => new Response("ok", { status: 200 });
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toIso", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("passes %s through as null", (_label, value) => {
    expect(toIso(value)).toBeNull();
  });

  it("normalises a Date and the string postgres.js actually returns to the same ISO", () => {
    const iso = "2026-03-15T12:00:00.000Z";

    expect(toIso(new Date(iso))).toBe(iso);
    expect(toIso(iso)).toBe(iso);
  });
});

describe("postEmail without a Resend key", () => {
  it("reports success through the stdout transport and opens no socket", async () => {
    await expect(postEmail("ops@example.test", "title", "body")).resolves.toBe(200);
    expect(calls).toEqual([]);
  });
});

describe("deliver to an email channel", () => {
  it("uses the configured recipient", async () => {
    await expect(
      deliver(delivery({ channel_kind: "email", config: { to: "ops@example.test" } })),
    ).resolves.toBe(200);
  });

  it("refuses a channel with no recipient rather than silently dropping the page", async () => {
    await expect(deliver(delivery({ channel_kind: "email", config: {} }))).rejects.toThrow(
      "email channel has no `to` address",
    );
  });
});

describe("deliver to a slack channel", () => {
  it("posts the title as text and the body as a coloured attachment", async () => {
    await deliver(delivery({ channel_kind: "slack", config: { url: "https://slack.test/hook" } }));

    expect(calls[0]?.url).toBe("https://slack.test/hook");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(bodyOf()).toEqual({
      text: "Down: API — checkout",
      attachments: [{ color: "#ef4444", text: expect.stringContaining("Monitor: API — checkout") }],
    });
  });

  it("refuses a channel with no webhook url", async () => {
    await expect(deliver(delivery({ channel_kind: "slack", config: {} }))).rejects.toThrow(
      "slack channel has no webhook url",
    );
  });
});

describe("deliver to a discord channel", () => {
  it.each([
    ["down", "open", 0xef_44_44],
    ["partial", "open", 0xf5_9e_0b],
    ["degraded", "open", 0xf5_9e_0b],
    ["down", "resolve", 0x10_b9_81],
  ] as const)(
    "renders a %s %s embed with the brand colour as an integer",
    async (severity, kind, color) => {
      await deliver(
        delivery({
          channel_kind: "discord",
          config: { url: "https://discord.test/hook" },
          severity,
          kind,
        }),
      );

      expect(bodyOf()).toEqual({
        embeds: [{ title: expect.any(String), description: expect.any(String), color }],
      });
    },
  );

  it("refuses a channel with no webhook url", async () => {
    await expect(deliver(delivery({ channel_kind: "discord", config: {} }))).rejects.toThrow(
      "discord channel has no webhook url",
    );
  });
});

describe("deliver to a webhook channel", () => {
  it("sends the documented incident envelope", async () => {
    await deliver(delivery());

    expect(bodyOf()).toEqual({
      event: "incident.opened",
      incidentId: "inc-1",
      monitor: {
        id: "mon-1",
        name: "API — checkout",
        url: "https://api.example.test/checkout",
      },
      severity: "down",
      primaryFailureCode: "HTTP_5XX",
      affectedRegions: ["bom", "fra"],
      startedAt: "2026-03-15T12:00:00.000Z",
      resolvedAt: null,
    });
  });

  it("switches the event name when the incident resolved", async () => {
    await deliver(delivery({ kind: "resolve", resolved_at: "2026-03-15T12:30:00.000Z" }));

    expect(bodyOf()).toMatchObject({
      event: "incident.resolved",
      resolvedAt: "2026-03-15T12:30:00.000Z",
    });
  });

  it("sends no signature headers when the channel has no secret", async () => {
    await deliver(delivery());

    expect(calls[0]?.headers.get("x-sentinel-signature")).toBeNull();
    expect(calls[0]?.headers.get("x-sentinel-timestamp")).toBeNull();
  });

  it("signs HMAC-SHA256 over `timestamp.body`, recomputed here from node:crypto", async () => {
    const secret = "whsec_test";
    await deliver(delivery({ config: { url: "https://hooks.example.test/sentinel", secret } }));

    const call = calls[0];
    const timestamp = call?.headers.get("x-sentinel-timestamp") ?? "";
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${call?.body ?? ""}`)
      .digest("hex");

    expect(Number(timestamp)).toBeGreaterThan(1_700_000_000);
    expect(call?.headers.get("x-sentinel-signature")).toBe(expected);
  });

  it("refuses a channel with no url", async () => {
    await expect(deliver(delivery({ config: {} }))).rejects.toThrow("webhook channel has no url");
  });

  it("raises the status and a truncated body when the endpoint rejects the post", async () => {
    nextResponse = () => new Response("x".repeat(500), { status: 503 });

    await expect(deliver(delivery())).rejects.toThrow(/^503: x{200}$/);
  });
});

describe("the message body an operator reads", () => {
  it("names the target, the failing regions and the diagnosed cause", async () => {
    await deliver(delivery({ channel_kind: "slack", config: { url: "https://slack.test/hook" } }));

    const body = String((bodyOf() as { attachments: { text: string }[] }).attachments[0]?.text);
    expect(body).toContain("Target: https://api.example.test/checkout");
    expect(body).toContain("Started at 2026-03-15T12:00:00.000Z");
    expect(body).toContain("Failing regions: bom, fra");
    expect(body).toContain("Cause: HTTP: server error");
    expect(body).toContain("Next step:");
    expect(body).toContain("http://localhost:3000/monitors/mon-1");
  });

  it("says n/a rather than leaving the regions line blank", async () => {
    await deliver(
      delivery({
        channel_kind: "slack",
        config: { url: "https://slack.test/hook" },
        affected_regions: [],
      }),
    );

    expect(String(calls[0]?.body)).toContain("Failing regions: n/a");
  });

  it("omits the cause when the failure code is not one Sentinel knows", async () => {
    await deliver(
      delivery({
        channel_kind: "slack",
        config: { url: "https://slack.test/hook" },
        primary_failure_code: "SOMETHING_NEW",
      }),
    );

    expect(String(calls[0]?.body)).not.toContain("Cause:");
  });

  it("drops the outage detail entirely once resolved", async () => {
    await deliver(
      delivery({
        channel_kind: "slack",
        config: { url: "https://slack.test/hook" },
        kind: "resolve",
        resolved_at: "2026-03-15T12:30:00.000Z",
      }),
    );

    const body = String(calls[0]?.body);
    expect(body).toContain("Resolved: API — checkout");
    expect(body).toContain("Recovered at 2026-03-15T12:30:00.000Z");
    expect(body).not.toContain("Failing regions");
  });
});
