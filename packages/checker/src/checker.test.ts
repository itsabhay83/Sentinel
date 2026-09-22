import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runHttpCheck } from "./http";
import { runTcpCheck } from "./tcp";
import { runDnsCheck } from "./dns";
import { runFlowCheck } from "./flow";
import { evaluateAssertions, readPath } from "./assertions";
import { classifyNodeError } from "./errors";
import {
  assertAllowedIp,
  isBlockedIp,
  pinnedLookup,
  validateTarget,
  BlockedTargetError,
} from "./ssrf";
import { ipInCidr, parseCidr, parseIp, unwrapIpv4Mapped } from "./ip";
import { startFixtureServer, startSelfSignedServer, type FixtureServer } from "./testing/fixture-server";

const LOCAL = { allowPrivateTargets: true } as const;

let server: FixtureServer;
let tlsServer: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
  tlsServer = await startSelfSignedServer();
});

afterAll(async () => {
  await server.close();
  await tlsServer.close();
});

// ---------------------------------------------------------------------------
// SSRF — spec Section 6. These run before any socket is opened.
// ---------------------------------------------------------------------------

describe("ssrf guard", () => {
  it("rejects the cloud metadata endpoint before opening a socket", async () => {
    const outcome = await runHttpCheck({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("BLOCKED_TARGET");
    expect(outcome.errorDetail).toContain("169.254.0.0/16");
    // No connection was attempted, so there is no TCP timing.
    expect(outcome.timing.tcpMs).toBeNull();
  });

  it("rejects localhost:5432 before opening a socket", async () => {
    const outcome = await runHttpCheck({ url: "http://localhost:5432/" });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("BLOCKED_TARGET");
    expect(outcome.timing.tcpMs).toBeNull();
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.5.4", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["0.0.0.0", "this network"],
    ["::1", "loopback"],
    ["fc00::1", "unique local"],
    ["fe80::1", "link-local"],
    ["100.64.0.1", "carrier NAT"],
  ])("blocks %s", (address) => {
    expect(isBlockedIp(address)).toBe(true);
    expect(() => assertAllowedIp(address)).toThrow(BlockedTargetError);
  });

  it.each([["1.1.1.1"], ["8.8.8.8"], ["93.184.216.34"], ["2606:4700:4700::1111"]])(
    "allows public address %s",
    (address) => {
      expect(isBlockedIp(address)).toBe(false);
    },
  );

  it("blocks IPv4-mapped IPv6 addresses that smuggle a private target", () => {
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });

  it.each([["file:///etc/passwd"], ["gopher://example.com/"], ["ftp://example.com/"], ["ldap://example.com/"]])(
    "rejects the %s scheme",
    async (url) => {
      const outcome = await runHttpCheck({ url });
      expect(outcome.failureCode).toBe("BLOCKED_TARGET");
    },
  );

  it("pins the resolved IP so a rebinding swap cannot take effect", async () => {
    const target = await validateTarget(`${server.url}/ok`, LOCAL);
    expect(target.address).toBe("127.0.0.1");
    expect(target.family).toBe(4);
    // pinnedLookup ignores whatever hostname the agent passes in.
    expect(target.hostname).toBe("127.0.0.1");
  });

  it("answers both of Node's lookup calling conventions", async () => {
    const target = await validateTarget(`${server.url}/ok`, LOCAL);
    const lookup = pinnedLookup(target);

    // Happy Eyeballs path: net.connect passes { all: true } and reads
    // addresses[0].address. A bare string here throws ERR_INVALID_IP_ADDRESS.
    const all = await new Promise<unknown>((resolve) => {
      lookup("evil.example.com", { all: true, family: 0 }, (_err, value) => resolve(value));
    });
    expect(all).toEqual([{ address: "127.0.0.1", family: 4 }]);

    const legacy = await new Promise<[unknown, unknown]>((resolve) => {
      lookup("evil.example.com", { family: 4 }, (_err, value, family) =>
        resolve([value, family]),
      );
    });
    expect(legacy).toEqual(["127.0.0.1", 4]);
  });
});

describe("ip primitives", () => {
  it("parses IPv4 and IPv6 into fixed-width bytes", () => {
    expect(parseIp("192.168.0.1")?.bytes).toEqual(new Uint8Array([192, 168, 0, 1]));
    expect(parseIp("::1")?.bytes.length).toBe(16);
    expect(parseIp("not-an-ip")).toBeNull();
  });

  it("matches CIDR ranges on non-byte-aligned prefixes", () => {
    const range = parseCidr("172.16.0.0/12", "private");
    expect(ipInCidr(parseIp("172.16.0.1")!, range)).toBe(true);
    expect(ipInCidr(parseIp("172.31.255.255")!, range)).toBe(true);
    expect(ipInCidr(parseIp("172.32.0.1")!, range)).toBe(false);
    expect(ipInCidr(parseIp("172.15.255.255")!, range)).toBe(false);
  });

  it("unwraps IPv4-mapped IPv6 into a real v4 address", () => {
    const mapped = parseIp("::ffff:192.168.1.1");
    expect(mapped).not.toBeNull();
    const unwrapped = unwrapIpv4Mapped(mapped!);
    expect(unwrapped.family).toBe(4);
    expect(unwrapped.bytes).toEqual(new Uint8Array([192, 168, 1, 1]));
  });
});

// ---------------------------------------------------------------------------
// HTTP check — timings, statuses, redirects, size cap, assertions
// ---------------------------------------------------------------------------

describe("runHttpCheck", () => {
  it("succeeds and reports a full timing breakdown", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/ok`, resolve: LOCAL });
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);
    expect(outcome.failureCode).toBeNull();
    expect(outcome.resolvedIp).toBe("127.0.0.1");
    expect(outcome.timing.dnsMs).not.toBeNull();
    expect(outcome.timing.tcpMs).not.toBeNull();
    expect(outcome.timing.ttfbMs).not.toBeNull();
    expect(outcome.timing.transferMs).not.toBeNull();
    expect(outcome.timing.totalMs).toBeGreaterThan(0);
    expect(outcome.responseHeaders?.["x-sentinel-test"]).toBe("ok");
  });

  it("captures TTFB separately from transfer on a slow response", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/slow?ms=250`, resolve: LOCAL });
    expect(outcome.ok).toBe(true);
    expect(outcome.timing.ttfbMs ?? 0).toBeGreaterThanOrEqual(200);
  });

  it("classifies 4xx as HTTP_4XX", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/status/404`, resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("HTTP_4XX");
    expect(outcome.statusCode).toBe(404);
  });

  it("classifies 5xx as HTTP_5XX", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/status/503`, resolve: LOCAL });
    expect(outcome.failureCode).toBe("HTTP_5XX");
    expect(outcome.statusCode).toBe(503);
  });

  it("accepts a non-2xx status when the monitor expects it", async () => {
    const outcome = await runHttpCheck({
      url: `${server.url}/status/401`,
      expectedStatusCodes: [401],
      resolve: LOCAL,
    });
    expect(outcome.ok).toBe(true);
  });

  it("follows redirects up to the cap", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/redirect/3`, resolve: LOCAL });
    expect(outcome.ok).toBe(true);
    expect(outcome.redirectChain.length).toBe(3);
  });

  it("detects a redirect loop", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/loop`, resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("HTTP_REDIRECT_LOOP");
  });

  it("aborts an oversized body at the 2 MB cap", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/large?mb=4`, resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("HTTP_TOO_LARGE");
  });

  it("classifies a mid-response socket destroy as TCP_RESET", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/reset`, resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("TCP_RESET");
  });

  it("times out with HTTP_TIMEOUT when the server is slower than the budget", async () => {
    const outcome = await runHttpCheck({ url: `${server.url}/slow?ms=3000`, timeoutMs: 400, resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("HTTP_TIMEOUT");
  });

  it("reports TCP_REFUSED against a closed port", async () => {
    const outcome = await runHttpCheck({ url: "http://127.0.0.1:1/", resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("TCP_REFUSED");
  });

  it("reports DNS_NXDOMAIN for a name that does not resolve", async () => {
    const outcome = await runHttpCheck({
      url: "http://sentinel-nonexistent-host-9f2a1c.invalid/",
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("DNS_NXDOMAIN");
  });

  it("rejects an untrusted (self-signed) certificate", async () => {
    const outcome = await runHttpCheck({ url: `${tlsServer.url}/ok`, resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(["TLS_UNTRUSTED", "TLS_HOSTNAME_MISMATCH", "TLS_HANDSHAKE_FAILED"]).toContain(outcome.failureCode);
  });
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe("assertions", () => {
  it("fails when a required keyword is missing", async () => {
    const outcome = await runHttpCheck({
      url: `${server.url}/ok`,
      assertions: [{ kind: "keyword", target: null, operator: "contains", value: "unhealthy" }],
      resolve: LOCAL,
    });
    expect(outcome.failureCode).toBe("ASSERT_KEYWORD_MISSING");
  });

  it("fails when a forbidden keyword is present", async () => {
    const outcome = await runHttpCheck({
      url: `${server.url}/ok`,
      assertions: [{ kind: "not_keyword", target: null, operator: "contains", value: "healthy" }],
      resolve: LOCAL,
    });
    expect(outcome.failureCode).toBe("ASSERT_KEYWORD_PRESENT");
  });

  it("evaluates a JSONPath assertion", async () => {
    const pass = await runHttpCheck({
      url: `${server.url}/ok`,
      assertions: [{ kind: "jsonpath", target: "$.status", operator: "equals", value: "healthy" }],
      resolve: LOCAL,
    });
    expect(pass.ok).toBe(true);

    const fail = await runHttpCheck({
      url: `${server.url}/ok`,
      assertions: [{ kind: "jsonpath", target: "$.status", operator: "equals", value: "degraded" }],
      resolve: LOCAL,
    });
    expect(fail.failureCode).toBe("ASSERT_JSONPATH_FAILED");
  });

  it("evaluates a header assertion", async () => {
    const outcome = await runHttpCheck({
      url: `${server.url}/headers`,
      assertions: [{ kind: "header", target: "x-api-version", operator: "equals", value: "2025-01-01" }],
      resolve: LOCAL,
    });
    expect(outcome.failureCode).toBe("ASSERT_HEADER_FAILED");
  });

  it("enforces a response-time budget", async () => {
    const outcome = await runHttpCheck({
      url: `${server.url}/slow?ms=300`,
      assertions: [{ kind: "response_time", target: null, operator: "lte", value: "50" }],
      resolve: LOCAL,
    });
    expect(outcome.failureCode).toBe("ASSERT_RESPONSE_TIME");
  });

  it("returns the first failure, not all of them", () => {
    const failure = evaluateAssertions(
      [
        { kind: "keyword", target: null, operator: "contains", value: "alpha" },
        { kind: "keyword", target: null, operator: "contains", value: "beta" },
      ],
      { body: "gamma", headers: {}, statusCode: 200, responseTimeMs: 10 },
    );
    expect(failure?.detail).toContain("alpha");
  });

  it("reads nested paths and array indices", () => {
    const doc = { data: { items: [{ id: "a" }, { id: "b" }] } };
    expect(readPath(doc, "$.data.items[1].id")).toBe("b");
    expect(readPath(doc, "data.items[0].id")).toBe("a");
    expect(readPath(doc, "$.missing.deep")).toBeUndefined();
  });

  it("treats an invalid user regex as a failed assertion, not a crash", () => {
    const failure = evaluateAssertions(
      [{ kind: "header", target: "x", operator: "matches", value: "([" }],
      { body: "", headers: { x: "y" }, statusCode: 200, responseTimeMs: 1 },
    );
    expect(failure?.code).toBe("ASSERT_HEADER_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe("classifyNodeError", () => {
  it.each([
    ["ENOTFOUND", "DNS_NXDOMAIN"],
    ["EAI_AGAIN", "DNS_TIMEOUT"],
    ["ECONNREFUSED", "TCP_REFUSED"],
    ["ECONNRESET", "TCP_RESET"],
    ["ETIMEDOUT", "TCP_TIMEOUT"],
    ["EHOSTUNREACH", "TCP_UNREACHABLE"],
    ["CERT_HAS_EXPIRED", "TLS_EXPIRED"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_HOSTNAME_MISMATCH"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS_UNTRUSTED"],
    ["EPROTO", "TLS_PROTOCOL_ERROR"],
  ])("maps %s to %s", (code, expected) => {
    expect(classifyNodeError(Object.assign(new Error("boom"), { code })).code).toBe(expected);
  });

  it("maps an abort to HTTP_TIMEOUT", () => {
    expect(classifyNodeError(new Error("aborted"), true).code).toBe("HTTP_TIMEOUT");
  });

  it("unwraps a nested cause", () => {
    const wrapped = new Error("fetch failed");
    (wrapped as { cause?: unknown }).cause = Object.assign(new Error("inner"), { code: "ECONNREFUSED" });
    expect(classifyNodeError(wrapped).code).toBe("TCP_REFUSED");
  });

  it("falls back to UNKNOWN", () => {
    expect(classifyNodeError(new Error("something odd")).code).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// TCP / DNS / flow checks
// ---------------------------------------------------------------------------

describe("runTcpCheck", () => {
  it("connects to an open port", async () => {
    const outcome = await runTcpCheck({ host: "127.0.0.1", port: server.port, resolve: LOCAL });
    expect(outcome.ok).toBe(true);
    expect(outcome.timing.tcpMs).not.toBeNull();
  });

  it("reports TCP_REFUSED on a closed port", async () => {
    const outcome = await runTcpCheck({ host: "127.0.0.1", port: 1, resolve: LOCAL });
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe("TCP_REFUSED");
  });

  it("refuses a private target when the guard is on", async () => {
    const outcome = await runTcpCheck({ host: "127.0.0.1", port: server.port });
    expect(outcome.failureCode).toBe("BLOCKED_TARGET");
  });
});

// Needs real recursive DNS: probe once and skip rather than report an offline
// machine or a blackholing resolver as a checker bug.
const dnsReachable = await runDnsCheck({ host: "example.com", recordType: "A", timeoutMs: 8000 })
  .then((outcome) => outcome.ok)
  .catch(() => false);

describe.skipIf(!dnsReachable)("runDnsCheck", () => {
  it("resolves a public name", async () => {
    const outcome = await runDnsCheck({ host: "example.com", recordType: "A", timeoutMs: 8000 });
    expect(outcome.ok).toBe(true);
    expect(outcome.timing.dnsMs).not.toBeNull();
  });

  it("reports a missing name", async () => {
    const outcome = await runDnsCheck({ host: "sentinel-nonexistent-9f2a1c.invalid", timeoutMs: 8000 });
    expect(outcome.ok).toBe(false);
    expect(["DNS_NXDOMAIN", "DNS_SERVFAIL", "DNS_TIMEOUT"]).toContain(outcome.failureCode);
  });
});

describe("runFlowCheck", () => {
  it("chains a token from step 1 into step 2", async () => {
    const result = await runFlowCheck({
      steps: [
        {
          name: "login",
          url: `${server.url}/login`,
          method: "POST",
          body: JSON.stringify({ user: "a" }),
          headers: { "content-type": "application/json" },
          extract: { token: "$.access_token" },
        },
        {
          name: "profile",
          url: `${server.url}/me`,
          headers: { authorization: "Bearer {{token}}" },
          assertions: [{ kind: "jsonpath", target: "$.plan", operator: "equals", value: "pro" }],
        },
      ],
      resolve: LOCAL,
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.outcome.statusCode).toBe(200);
    expect(result.totalMs).toBeGreaterThan(0);
  });

  it("stops at the first failing step and names it", async () => {
    const result = await runFlowCheck({
      steps: [
        { name: "login", url: `${server.url}/login`, method: "POST" },
        { name: "profile", url: `${server.url}/me` },
        { name: "never-runs", url: `${server.url}/ok` },
      ],
      resolve: LOCAL,
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("profile");
    expect(result.failureCode).toBe("HTTP_4XX");
    expect(result.steps).toHaveLength(2);
  });

  it("supports the step1 ordinal alias", async () => {
    const result = await runFlowCheck({
      steps: [
        { name: "login", url: `${server.url}/login`, method: "POST" },
        { name: "profile", url: `${server.url}/me`, headers: { authorization: "Bearer {{step1.body.access_token}}" } },
      ],
      resolve: LOCAL,
    });
    expect(result.ok).toBe(true);
  });
});
