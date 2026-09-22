/**
 * Seed script — creates a realistic, fully-populated Sentinel instance.
 *
 * Volume strategy (this matters; naive seeding here takes 20 minutes):
 *   - Raw `checks`: last 24h only, generated in JS so every row carries a real
 *     phase breakdown, failure code and incident correlation. ~46k rows.
 *   - `check_rollups_5m` (7 days) and `check_rollups_1h` (90 days): generated
 *     SERVER-SIDE with generate_series. That is ~670k rows that never cross the
 *     wire. Doing this from JS would be the difference between 6 seconds and
 *     several minutes.
 *
 * Re-running is safe: the script truncates the tenant data it owns first.
 */
import { randomUUID } from "node:crypto";

import { REGIONS, type FailureCode } from "@sentinel/shared";
import { encryptJson, generateApiKey, generateId, generateToken, hashPassword } from "@sentinel/shared/server";
import { getServerEnv } from "@sentinel/shared/env";
import { sql as rawSql } from "drizzle-orm";

import { closeDb, db } from "../client";
import {
  accounts,
  alertChannels,
  apiKeys,
  assertions,
  checkRollups1h,
  checkRollups5m,
  checks,
  escalationPolicies,
  escalationSteps,
  flowSteps,
  heartbeats,
  incidentEvents,
  incidents,
  latencyBaselines,
  maintenanceWindows,
  members,
  monitorCertificates,
  monitorPolicies,
  monitorRegions,
  monitorState,
  monitors,
  organizations,
  regions,
  slos,
  statusPageMonitors,
  statusPages,
  users,
} from "../schema/index";

const env = getServerEnv();

/** Deterministic PRNG so repeated seeds produce identical dashboards. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Approximate round-trip latency floor between a probe region and the region a
 * service is hosted in. Real geography, so the map and waterfall tell a
 * coherent story instead of showing noise.
 */
const REGION_BASE_MS: Record<string, number> = {
  bom: 148,
  sin: 96,
  fra: 42,
  lhr: 38,
  iad: 22,
  sjc: 74,
  gru: 132,
  syd: 186,
};

interface MonitorSeed {
  name: string;
  url: string;
  type: "http" | "tcp" | "ping" | "dns" | "heartbeat" | "flow";
  groupName: string;
  tags: string[];
  intervalSeconds: number;
  /** Fraction of cycles that fail, per region, over the seeded history. */
  reliability: number;
  /** Steady-state status the dashboard should show right now. */
  finalStatus: "UP" | "DOWN" | "PARTIAL_OUTAGE" | "DEGRADED" | "PAUSED";
  failureCode: FailureCode;
  /** Regions that misbehave for PARTIAL_OUTAGE / DEGRADED monitors. */
  troubleRegions: string[];
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const MONITOR_SEEDS: MonitorSeed[] = [
  {
    name: "Marketing site",
    url: "https://example.com/",
    type: "http",
    groupName: "Public",
    tags: ["public", "web"],
    intervalSeconds: 60,
    reliability: 0.999,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "App shell",
    url: "https://www.wikipedia.org/",
    type: "http",
    groupName: "Public",
    tags: ["public", "web"],
    intervalSeconds: 60,
    reliability: 0.998,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "API — health",
    url: "https://dns.google/resolve?name=example.com&type=A",
    type: "http",
    groupName: "API",
    tags: ["api", "critical"],
    intervalSeconds: 30,
    reliability: 0.9995,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "API — checkout",
    url: "https://checkout.acme-rockets.invalid/v1/checkout",
    type: "http",
    groupName: "API",
    tags: ["api", "critical", "revenue"],
    intervalSeconds: 30,
    reliability: 0.991,
    finalStatus: "DOWN",
    failureCode: "HTTP_5XX",
    troubleRegions: [],
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer seed-token-do-not-use" },
    body: '{"probe":true}',
  },
  {
    name: "API — search",
    url: "https://www.cloudflare.com/",
    type: "http",
    groupName: "API",
    tags: ["api"],
    intervalSeconds: 60,
    reliability: 0.996,
    finalStatus: "DEGRADED",
    failureCode: "ASSERT_RESPONSE_TIME",
    troubleRegions: ["syd", "gru"],
  },
  {
    name: "CDN edge",
    url: "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js",
    type: "http",
    groupName: "Infrastructure",
    tags: ["cdn"],
    intervalSeconds: 300,
    reliability: 0.9985,
    finalStatus: "PARTIAL_OUTAGE",
    failureCode: "TCP_TIMEOUT",
    troubleRegions: ["gru"],
  },
  {
    name: "Auth service",
    url: "https://accounts.google.com/.well-known/openid-configuration",
    type: "http",
    groupName: "API",
    tags: ["api", "critical"],
    intervalSeconds: 60,
    reliability: 0.9975,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Docs",
    url: "https://developer.mozilla.org/en-US/",
    type: "http",
    groupName: "Public",
    tags: ["public", "docs"],
    intervalSeconds: 300,
    reliability: 0.997,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Status ingest",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    type: "http",
    groupName: "Pipeline",
    tags: ["pipeline"],
    intervalSeconds: 60,
    reliability: 0.995,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
    body: '{"ping":1}',
  },
  {
    name: "Webhook dispatcher",
    url: "https://www.iana.org/",
    type: "http",
    groupName: "Pipeline",
    tags: ["pipeline"],
    intervalSeconds: 120,
    reliability: 0.994,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Primary Postgres",
    url: "tcp://one.one.one.one:443",
    type: "tcp",
    groupName: "Infrastructure",
    tags: ["database", "critical"],
    intervalSeconds: 60,
    reliability: 0.9992,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Redis cluster",
    url: "tcp://one.one.one.one:53",
    type: "tcp",
    groupName: "Infrastructure",
    tags: ["cache"],
    intervalSeconds: 60,
    reliability: 0.9988,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "SMTP relay",
    url: "tcp://smtp.gmail.com:587",
    type: "tcp",
    groupName: "Infrastructure",
    tags: ["email"],
    intervalSeconds: 300,
    reliability: 0.998,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Apex DNS",
    url: "dns://example.com",
    type: "dns",
    groupName: "Infrastructure",
    tags: ["dns"],
    intervalSeconds: 300,
    reliability: 0.9995,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Edge gateway ICMP",
    url: "ping://one.one.one.one",
    type: "ping",
    groupName: "Infrastructure",
    tags: ["network"],
    intervalSeconds: 60,
    reliability: 0.997,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "EU billing worker",
    url: "https://www.bbc.co.uk/",
    type: "http",
    groupName: "Workers",
    tags: ["worker", "eu"],
    intervalSeconds: 120,
    reliability: 0.993,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "US billing worker",
    url: "https://duckduckgo.com/",
    type: "http",
    groupName: "Workers",
    tags: ["worker", "us"],
    intervalSeconds: 120,
    reliability: 0.993,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Legacy exports",
    url: "https://legacy.acme-rockets.invalid/exports",
    type: "http",
    groupName: "Workers",
    tags: ["legacy"],
    intervalSeconds: 900,
    reliability: 0.98,
    finalStatus: "PAUSED",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Nightly ETL heartbeat",
    url: "heartbeat://nightly-etl",
    type: "heartbeat",
    groupName: "Workers",
    tags: ["cron"],
    intervalSeconds: 3600,
    reliability: 0.999,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
  {
    name: "Checkout flow (3 steps)",
    url: "https://dns.google/resolve?name=example.com&type=A",
    type: "flow",
    groupName: "API",
    tags: ["flow", "critical", "revenue"],
    intervalSeconds: 300,
    reliability: 0.992,
    finalStatus: "UP",
    failureCode: "UNKNOWN",
    troubleRegions: [],
  },
];

const DEMO_EMAIL = "demo@sentinel.dev";
const DEMO_PASSWORD = "sentinel123";
const TEAMMATE_EMAIL = "teammate@sentinel.dev";

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log("→ seeding Sentinel…");

  // Truncate everything we own. RESTART IDENTITY + CASCADE keeps this a single
  // statement instead of a 20-table dependency-ordered delete.
  await db.execute(rawSql`
    TRUNCATE TABLE
      organizations, users, regions, monitors, checks,
      check_rollups_5m, check_rollups_1h, latency_baselines,
      incidents, incident_events, alert_channels, escalation_policies,
      maintenance_windows, status_pages
    RESTART IDENTITY CASCADE
  `);

  // ---------------------------------------------------------------- regions
  await db.insert(regions).values(
    REGIONS.map((region) => ({
      code: region.code,
      city: region.city,
      country: region.country,
      lat: region.lat,
      lng: region.lng,
      enabled: true,
      healthStatus: "healthy" as const,
      lastSeenAt: new Date(),
    })),
  );
  console.log(`  ✓ ${REGIONS.length} regions`);

  // ------------------------------------------------------- org + membership
  const orgId = generateId("org");
  const ownerId = generateId("usr");
  const teammateId = generateId("usr");
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await db.transaction(async (tx) => {
    await tx.insert(users).values([
      { id: ownerId, name: "Demo Owner", email: DEMO_EMAIL, emailVerified: true },
      { id: teammateId, name: "Demo Teammate", email: TEAMMATE_EMAIL, emailVerified: true },
    ]);

    // Credentials live on `accounts` (providerId 'credential'), matching the
    // Better Auth table shape so the provider stays swappable later.
    await tx.insert(accounts).values([
      {
        id: generateId("acc"),
        accountId: DEMO_EMAIL,
        providerId: "credential",
        userId: ownerId,
        password: passwordHash,
      },
      {
        id: generateId("acc"),
        accountId: TEAMMATE_EMAIL,
        providerId: "credential",
        userId: teammateId,
        password: passwordHash,
      },
    ]);

    await tx.insert(organizations).values({
      id: orgId,
      name: "Acme Rockets",
      slug: "acme-rockets",
      plan: "pro",
    });

    await tx.insert(members).values([
      { id: generateId("mem"), organizationId: orgId, userId: ownerId, role: "owner" },
      { id: generateId("mem"), organizationId: orgId, userId: teammateId, role: "member" },
    ]);
  });
  console.log(`  ✓ org acme-rockets with 2 users (${DEMO_EMAIL} / ${DEMO_PASSWORD})`);

  const apiKey = generateApiKey(env.API_KEY_HMAC_SECRET);
  await db.insert(apiKeys).values({
    organizationId: orgId,
    name: "Seed CI key",
    hashedKey: apiKey.hashed,
    keyPrefix: apiKey.key.slice(0, 12),
    scopes: ["monitors:read", "monitors:write", "incidents:read"],
  });

  // --------------------------------------------------------------- monitors
  const allRegionCodes = REGIONS.map((r) => r.code);
  const monitorRows = MONITOR_SEEDS.map((seed) => ({
    id: randomUUID(),
    organizationId: orgId,
    name: seed.name,
    type: seed.type,
    url: seed.url,
    method: seed.method ?? "GET",
    headersEncrypted: seed.headers ? encryptJson(seed.headers, env.ENCRYPTION_KEY) : null,
    bodyEncrypted: seed.body ? encryptJson(seed.body, env.ENCRYPTION_KEY) : null,
    intervalSeconds: seed.intervalSeconds,
    timeoutMs: 30_000,
    followRedirects: true,
    maxRedirects: 5,
    expectedStatusCodes: seed.type === "http" || seed.type === "flow" ? [200, 201, 204] : [],
    quorumRatio: "0.60",
    minRegionsRequired: 2,
    confirmationFailures: 2,
    confirmationSuccesses: 2,
    degradedThresholdMs: seed.name === "API — search" ? 250 : null,
    tags: seed.tags,
    groupName: seed.groupName,
    paused: seed.finalStatus === "PAUSED",
  }));
  await db.insert(monitors).values(monitorRows);

  await db.insert(monitorRegions).values(
    monitorRows.flatMap((monitor) =>
      allRegionCodes.map((code) => ({
        monitorId: monitor.id,
        regionCode: code,
        enabled: true,
      })),
    ),
  );

  await db.insert(assertions).values([
    {
      monitorId: monitorRows[2]!.id,
      kind: "jsonpath" as const,
      target: "$.Question[0].name",
      operator: "contains",
      value: "example.com",
      orderIndex: 0,
    },
    {
      monitorId: monitorRows[2]!.id,
      kind: "response_time" as const,
      target: null,
      operator: "lt",
      value: "1500",
      orderIndex: 1,
    },
    {
      monitorId: monitorRows[4]!.id,
      kind: "response_time" as const,
      target: null,
      operator: "lt",
      value: "800",
      orderIndex: 0,
    },
    {
      monitorId: monitorRows[0]!.id,
      kind: "keyword" as const,
      target: null,
      operator: "contains",
      value: "Example Domain",
      orderIndex: 0,
    },
    {
      monitorId: monitorRows[6]!.id,
      kind: "header" as const,
      target: "content-type",
      operator: "contains",
      value: "application/json",
      orderIndex: 0,
    },
  ]);

  const heartbeatMonitor = monitorRows.find((m) => m.type === "heartbeat")!;
  await db.insert(heartbeats).values({
    monitorId: heartbeatMonitor.id,
    expectedEverySeconds: 3600,
    graceSeconds: 600,
    lastPingAt: new Date(Date.now() - 12 * 60_000),
    pingToken: generateToken(16),
  });

  const flowMonitor = monitorRows.find((m) => m.type === "flow")!;
  await db.insert(flowSteps).values([
    // A three-hop chain against Google Public DNS over HTTPS. Steps 2 and 3 build
    // their query from a value the first response returned, so the chain proves the
    // interpolation engine rather than just issuing three unrelated requests.
    // DoH is deliberate: this seed polls every 30s from every probe region, which
    // burns through an authenticated API's rate limit in minutes (api.github.com
    // caps unauthenticated callers at 60/hour and started returning 403 here).
    {
      monitorId: flowMonitor.id,
      orderIndex: 0,
      name: "resolve-a",
      url: "https://dns.google/resolve?name=example.com&type=A",
      method: "GET",
      headersEncrypted: encryptJson({ accept: "application/json" }, env.ENCRYPTION_KEY),
      bodyEncrypted: null,
      expectedStatusCodes: [200],
      // Resolves to "example.com." — DNS returns fully-qualified names with the
      // root label's trailing dot, which is still a valid query name in step 2.
      extract: { domain: "$.Question[0].name" },
    },
    {
      monitorId: flowMonitor.id,
      orderIndex: 1,
      name: "resolve-aaaa",
      url: "https://dns.google/resolve?name={{domain}}&type=AAAA",
      method: "GET",
      headersEncrypted: encryptJson({ accept: "application/json" }, env.ENCRYPTION_KEY),
      bodyEncrypted: null,
      expectedStatusCodes: [200],
      extract: {},
    },
    {
      monitorId: flowMonitor.id,
      orderIndex: 2,
      name: "resolve-ns",
      // Uses the `step1.*` ordinal alias instead of the named extract so this one
      // monitor covers both interpolation paths, and indexes into an array to
      // cover the JSONPath reader's bracket syntax too.
      url: "https://dns.google/resolve?name={{step1.body.Question[0].name}}&type=NS",
      method: "GET",
      headersEncrypted: encryptJson({ accept: "application/json" }, env.ENCRYPTION_KEY),
      bodyEncrypted: null,
      expectedStatusCodes: [200],
      extract: {},
    },
  ]);

  await db.insert(slos).values(
    monitorRows
      .filter((m) => m.tags.includes("critical"))
      .map((m) => ({
        monitorId: m.id,
        targetPercent: "99.900",
        windowDays: 30,
      })),
  );

  const certMonitors = monitorRows.filter((m) => m.url.startsWith("https://"));
  await db.insert(monitorCertificates).values(
    certMonitors.map((m, index) => {
      const host = new URL(m.url).hostname;
      // Spread expiries so the SSL tab shows healthy, 30-day, 14-day and 6-day states.
      const daysOut = [83, 61, 30, 14, 6, 121, 200, 45, 97, 12, 155, 74][index % 12]!;
      return {
        monitorId: m.id,
        host,
        certExpiresAt: new Date(Date.now() + daysOut * 86_400_000),
        certIssuer: "R11",
        certSubject: host,
        domain: host.split(".").slice(-2).join("."),
        domainExpiresAt: new Date(Date.now() + (daysOut + 240) * 86_400_000),
        registrar: "Example Registrar, Inc.",
        checkedAt: new Date(),
      };
    }),
  );
  console.log(`  ✓ ${monitorRows.length} monitors (+ assertions, SLOs, certs, flow, heartbeat)`);

  // -------------------------------------------------------------- alerting
  const emailChannelId = randomUUID();
  const webhookChannelId = randomUUID();
  const slackChannelId = randomUUID();
  await db.insert(alertChannels).values([
    {
      id: emailChannelId,
      organizationId: orgId,
      name: "On-call email",
      kind: "email",
      config: { to: DEMO_EMAIL },
      verifiedAt: new Date(),
    },
    // `.invalid` is deliberate: no demo can provision a real Slack/PagerDuty endpoint, so
    // these fail once per incident and Settings > Alerts shows both sent and failed states.
    {
      id: slackChannelId,
      organizationId: orgId,
      name: "#incidents",
      kind: "slack",
      config: { url: "https://hooks.slack.invalid/services/REPLACE/ME" },
      verifiedAt: null,
    },
    {
      id: webhookChannelId,
      organizationId: orgId,
      name: "PagerDuty bridge",
      kind: "webhook",
      config: {
        url: "https://events.pagerduty.invalid/sentinel",
        secret: generateToken(24),
      },
      verifiedAt: null,
    },
  ]);

  const policyId = randomUUID();
  await db.insert(escalationPolicies).values({
    id: policyId,
    organizationId: orgId,
    name: "Default escalation",
  });
  await db.insert(escalationSteps).values([
    { policyId, orderIndex: 0, afterMinutes: 0, channelIds: [emailChannelId, slackChannelId] },
    { policyId, orderIndex: 1, afterMinutes: 5, channelIds: [webhookChannelId] },
  ]);
  await db.insert(monitorPolicies).values(
    monitorRows.map((m) => ({ monitorId: m.id, policyId })),
  );

  await db.insert(maintenanceWindows).values({
    organizationId: orgId,
    monitorIds: [monitorRows[17]!.id],
    startsAt: new Date(Date.now() + 2 * 86_400_000),
    endsAt: new Date(Date.now() + 2 * 86_400_000 + 2 * 3_600_000),
    rrule: "FREQ=WEEKLY;BYDAY=SU",
    reason: "Legacy export migration — expected downtime",
  });
  console.log("  ✓ 3 alert channels, 2-step escalation policy, maintenance window");

  // ----------------------------------------------------------- status page
  const statusPageId = randomUUID();
  await db.insert(statusPages).values({
    id: statusPageId,
    organizationId: orgId,
    slug: "acme",
    title: "Acme Rockets Status",
    description: "Live availability for the Acme Rockets platform.",
    theme: { accent: "#10b981", mode: "dark" },
    showUptimeDays: 90,
    published: true,
    domainVerificationToken: generateToken(12),
  });
  await db.insert(statusPageMonitors).values(
    monitorRows
      .filter((m) => ["Public", "API", "Infrastructure"].includes(m.groupName))
      .map((m, index) => ({
        statusPageId,
        monitorId: m.id,
        displayName: m.name.replace("API — ", "").replace(/^./, (c) => c.toUpperCase()),
        groupName: m.groupName,
        orderIndex: index,
      })),
  );
  console.log("  ✓ published status page /status/acme");

  // ------------------------------------------------- raw checks (last 24 h)
  const CADENCE_MS = 5 * 60_000;
  const CYCLES = 288; // 24 hours
  const now = Date.now();
  const alignedNow = Math.floor(now / CADENCE_MS) * CADENCE_MS;

  interface IncidentDraft {
    id: string;
    monitorId: string;
    startedAt: Date;
    resolvedAt: Date | null;
    severity: "down" | "partial" | "degraded";
    primaryFailureCode: FailureCode;
    affectedRegions: string[];
  }
  const incidentDrafts: IncidentDraft[] = [];
  const checkBatch: (typeof checks.$inferInsert)[] = [];
  const baselineRows: (typeof latencyBaselines.$inferInsert)[] = [];
  const stateRows: (typeof monitorState.$inferInsert)[] = [];

  for (let mi = 0; mi < monitorRows.length; mi += 1) {
    const monitor = monitorRows[mi]!;
    const seed = MONITOR_SEEDS[mi]!;
    const rand = mulberry32(hashString(monitor.id));

    // Where in the last 24h this monitor's incident sits.
    const incidentActive = seed.finalStatus === "DOWN" || seed.finalStatus === "PARTIAL_OUTAGE";
    const incidentStartCycle = incidentActive
      ? CYCLES - 1 - Math.floor(rand() * 14 + 4)
      : Math.floor(rand() * 180 + 20);
    const incidentEndCycle = incidentActive
      ? CYCLES
      : incidentStartCycle + Math.floor(rand() * 6 + 3);
    const historicIncident = !incidentActive && seed.reliability < 0.997;

    const failingRegionsForIncident =
      seed.finalStatus === "PARTIAL_OUTAGE"
        ? seed.troubleRegions
        : seed.finalStatus === "DOWN"
          ? allRegionCodes.slice(0, 6)
          : allRegionCodes.slice(0, 5);

    const latencyByRegion = new Map<string, number[]>();

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const checkedAt = new Date(alignedNow - (CYCLES - 1 - cycle) * CADENCE_MS);
      const cycleId = randomUUID();
      const hourOfDay = checkedAt.getUTCHours() + checkedAt.getUTCMinutes() / 60;
      // Traffic-shaped diurnal curve: slowest around 15:00 UTC.
      const diurnal = 1 + 0.22 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);

      const inIncident =
        (incidentActive || historicIncident) &&
        cycle >= incidentStartCycle &&
        cycle < incidentEndCycle;

      for (const code of allRegionCodes) {
        if (monitor.paused) continue;

        const base = REGION_BASE_MS[code] ?? 80;
        const jitter = 0.82 + rand() * 0.45;
        const troubled = seed.troubleRegions.includes(code);
        const degradeFactor = troubled && seed.finalStatus === "DEGRADED" ? 3.4 : 1;

        const regionFails =
          inIncident && failingRegionsForIncident.includes(code)
            ? true
            : rand() > seed.reliability;

        const totalMs = Math.round(base * diurnal * jitter * degradeFactor);
        const dnsMs = regionFails ? null : Math.round(totalMs * 0.11 * (0.6 + rand() * 0.8));
        const tcpMs = regionFails ? null : Math.round(totalMs * 0.18 * (0.7 + rand() * 0.6));
        const tlsMs =
          regionFails || !monitor.url.startsWith("https://")
            ? null
            : Math.round(totalMs * 0.24 * (0.7 + rand() * 0.7));
        const ttfbMs = regionFails ? null : Math.round(totalMs * 0.38 * (0.8 + rand() * 0.5));
        const transferMs = regionFails
          ? null
          : Math.max(1, totalMs - (dnsMs ?? 0) - (tcpMs ?? 0) - (tlsMs ?? 0) - (ttfbMs ?? 0));

        const failureCode: FailureCode | null = regionFails
          ? inIncident
            ? seed.failureCode
            : rand() > 0.5
              ? "HTTP_5XX"
              : "TCP_TIMEOUT"
          : null;

        if (!regionFails) {
          const bucket = latencyByRegion.get(code) ?? [];
          bucket.push(totalMs);
          latencyByRegion.set(code, bucket);
        }

        checkBatch.push({
          monitorId: monitor.id,
          regionCode: code,
          cycleId,
          checkedAt,
          ok: !regionFails,
          statusCode: regionFails ? (failureCode === "HTTP_5XX" ? 503 : null) : 200,
          failureCode,
          errorDetail: regionFails ? `Probe ${code} reported ${failureCode}` : null,
          dnsMs,
          tcpMs,
          tlsMs,
          ttfbMs,
          transferMs,
          totalMs: regionFails ? Math.round(base * 2.1) : totalMs,
          responseSizeBytes: regionFails ? 0 : 1200 + Math.floor(rand() * 48_000),
          resolvedIp: `203.0.113.${(hashString(code) % 250) + 1}`,
          certExpiresAt: null,
          bodySnippet: regionFails ? '{"error":"upstream unavailable"}' : null,
          responseHeaders: regionFails ? {} : { "content-type": "application/json" },
        });
      }
    }

    for (const [code, values] of latencyByRegion) {
      const sorted = [...values].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
      baselineRows.push({
        monitorId: monitor.id,
        regionCode: code,
        p95Ms: p95,
        sampleCount: values.length,
        computedAt: new Date(),
      });
    }

    if (incidentActive || historicIncident) {
      incidentDrafts.push({
        id: randomUUID(),
        monitorId: monitor.id,
        startedAt: new Date(alignedNow - (CYCLES - 1 - incidentStartCycle) * CADENCE_MS),
        resolvedAt: incidentActive
          ? null
          : new Date(alignedNow - (CYCLES - 1 - incidentEndCycle) * CADENCE_MS),
        severity:
          seed.finalStatus === "PARTIAL_OUTAGE"
            ? "partial"
            : seed.finalStatus === "DEGRADED"
              ? "degraded"
              : "down",
        primaryFailureCode: seed.failureCode === "UNKNOWN" ? "HTTP_5XX" : seed.failureCode,
        affectedRegions: failingRegionsForIncident,
      });
    }

    const activeIncident = incidentDrafts.find(
      (d) => d.monitorId === monitor.id && d.resolvedAt === null,
    );
    const lastLatency = [...latencyByRegion.values()].flat().slice(-8);
    stateRows.push({
      monitorId: monitor.id,
      status: monitor.paused ? "PAUSED" : seed.finalStatus,
      since: new Date(alignedNow - (CYCLES - 1 - incidentStartCycle) * CADENCE_MS),
      lastCheckAt: new Date(alignedNow),
      nextRunAt: new Date(now + seed.intervalSeconds * 1000),
      consecutiveFailures: seed.finalStatus === "DOWN" ? 4 : 0,
      consecutiveSuccesses: seed.finalStatus === "UP" ? 12 : 0,
      currentIncidentId: activeIncident?.id ?? null,
      currentCycleId: null,
      failingRegions: seed.finalStatus === "UP" ? [] : failingRegionsForIncident,
      lastLatencyMs:
        lastLatency.length > 0
          ? Math.round(lastLatency.reduce((a, b) => a + b, 0) / lastLatency.length)
          : null,
    });
  }

  // Insert incidents before checks so monitor_state can reference them.
  if (incidentDrafts.length > 0) {
    await db.insert(incidents).values(
      incidentDrafts.map((d) => ({
        id: d.id,
        monitorId: d.monitorId,
        startedAt: d.startedAt,
        resolvedAt: d.resolvedAt,
        severity: d.severity,
        primaryFailureCode: d.primaryFailureCode,
        affectedRegions: d.affectedRegions,
        postmortem:
          d.resolvedAt !== null
            ? "Upstream provider confirmed a transient routing fault. No customer data affected."
            : null,
      })),
    );

    await db.insert(incidentEvents).values(
      incidentDrafts.flatMap((d) => {
        const events: (typeof incidentEvents.$inferInsert)[] = [
          {
            incidentId: d.id,
            at: d.startedAt,
            kind: "opened" as const,
            payload: {
              severity: d.severity,
              failureCode: d.primaryFailureCode,
              regions: d.affectedRegions,
            },
          },
          {
            incidentId: d.id,
            at: new Date(d.startedAt.getTime() + 60_000),
            kind: "escalated" as const,
            payload: { step: 0, channels: ["On-call email", "#incidents"] },
          },
        ];
        if (d.resolvedAt !== null) {
          events.push({
            incidentId: d.id,
            at: new Date(d.resolvedAt.getTime() - 120_000),
            kind: "region_recovered" as const,
            payload: { region: d.affectedRegions[0] ?? "iad" },
          });
          events.push({
            incidentId: d.id,
            at: d.resolvedAt,
            kind: "resolved" as const,
            payload: {
              durationMs: d.resolvedAt.getTime() - d.startedAt.getTime(),
            },
          });
        }
        return events;
      }),
    );
  }

  await insertInBatches(checkBatch, 2_000, (rows) => db.insert(checks).values(rows));
  await db.insert(latencyBaselines).values(baselineRows);
  await db.insert(monitorState).values(stateRows);
  console.log(
    `  ✓ ${checkBatch.length.toLocaleString()} raw checks, ${incidentDrafts.length} incidents, ${stateRows.length} monitor states`,
  );

  // ------------------------------------- rollups generated inside Postgres
  await db.execute(rawSql`
    WITH region_base(code, base_ms) AS (
      VALUES ('bom', 148), ('sin', 96), ('fra', 42), ('lhr', 38),
             ('iad', 22), ('sjc', 74), ('gru', 132), ('syd', 186)
    ),
    grid AS (
      SELECT mr.monitor_id,
             mr.region_code,
             b.bucket,
             rb.base_ms,
             GREATEST(1, 300 / m.interval_seconds) AS cnt,
             (abs(hashtext(mr.monitor_id::text || mr.region_code || b.bucket::text)) % 1000) AS roll
      FROM monitor_regions mr
      JOIN monitors m ON m.id = mr.monitor_id AND m.paused = false
      JOIN region_base rb ON rb.code = mr.region_code
      CROSS JOIN generate_series(
        date_trunc('hour', now()) - interval '7 days',
        date_trunc('hour', now()) - interval '5 minutes',
        interval '5 minutes'
      ) AS b(bucket)
    )
    INSERT INTO check_rollups_5m
      (monitor_id, region_code, bucket, count, ok_count, p50_ms, p95_ms, p99_ms, max_ms)
    SELECT
      monitor_id, region_code, bucket, cnt,
      CASE WHEN roll < 4 THEN GREATEST(0, cnt - 1) ELSE cnt END,
      p50, ROUND(p50 * 1.55), ROUND(p50 * 2.05), ROUND(p50 * 2.9)
    FROM (
      SELECT *,
             ROUND(base_ms
               * (1 + 0.22 * sin((EXTRACT(EPOCH FROM bucket) / 86400.0) * 2 * pi()))
               * (0.85 + (roll % 100) / 320.0))::int AS p50
      FROM grid
    ) s
  `);

  await db.execute(rawSql`
    WITH region_base(code, base_ms) AS (
      VALUES ('bom', 148), ('sin', 96), ('fra', 42), ('lhr', 38),
             ('iad', 22), ('sjc', 74), ('gru', 132), ('syd', 186)
    ),
    grid AS (
      SELECT mr.monitor_id,
             mr.region_code,
             b.bucket,
             rb.base_ms,
             GREATEST(1, 3600 / m.interval_seconds) AS cnt,
             (abs(hashtext(mr.monitor_id::text || mr.region_code || b.bucket::text)) % 1000) AS roll
      FROM monitor_regions mr
      JOIN monitors m ON m.id = mr.monitor_id AND m.paused = false
      JOIN region_base rb ON rb.code = mr.region_code
      CROSS JOIN generate_series(
        date_trunc('hour', now()) - interval '90 days',
        date_trunc('hour', now()) - interval '1 hour',
        interval '1 hour'
      ) AS b(bucket)
    )
    INSERT INTO check_rollups_1h
      (monitor_id, region_code, bucket, count, ok_count, p50_ms, p95_ms, p99_ms, max_ms)
    SELECT
      monitor_id, region_code, bucket, cnt,
      CASE
        WHEN roll < 3 THEN GREATEST(0, cnt - (cnt / 3))
        WHEN roll < 12 THEN GREATEST(0, cnt - 1)
        ELSE cnt
      END,
      p50, ROUND(p50 * 1.6), ROUND(p50 * 2.1), ROUND(p50 * 3.1)
    FROM (
      SELECT *,
             ROUND(base_ms
               * (1 + 0.22 * sin((EXTRACT(EPOCH FROM bucket) / 86400.0) * 2 * pi()))
               * (0.85 + (roll % 100) / 320.0))::int AS p50
      FROM grid
    ) s
  `);

  const [rollup5m] = await db.execute<{ n: string }>(
    rawSql`SELECT count(*)::text AS n FROM check_rollups_5m`,
  );
  const [rollup1h] = await db.execute<{ n: string }>(
    rawSql`SELECT count(*)::text AS n FROM check_rollups_1h`,
  );
  console.log(
    `  ✓ ${Number(rollup5m?.n ?? 0).toLocaleString()} 5m rollups (7d), ${Number(rollup1h?.n ?? 0).toLocaleString()} 1h rollups (90d)`,
  );

  console.log(`\n✓ seed complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`  login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  api key (shown once): ${apiKey.key}`);
  console.log(`  status page: http://localhost:3000/status/acme`);
}

async function insertInBatches<T>(
  rows: T[],
  size: number,
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("seed failed:", error);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
