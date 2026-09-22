import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { promisify } from "node:util";
import type { CheckOutcome, Timing } from "./http";
import { assertAllowedIp, BlockedTargetError, type ResolveOptions } from "./ssrf";
import { classifyNodeError } from "./errors";
import { parseIp } from "./ip";

const execFileAsync = promisify(execFile);

export interface PingCheckConfig {
  readonly host: string;
  readonly timeoutMs?: number;
  readonly resolve?: ResolveOptions;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * ICMP echo via the system `ping` binary.
 *
 * Raw ICMP sockets need CAP_NET_RAW/root, which we do not want on a $2 probe
 * machine, so we shell out. Two hard rules make that safe:
 *   1. `execFile` with an argv array — never a shell string, so no injection.
 *   2. We ping the RESOLVED AND VALIDATED IP, never the user's hostname, so the
 *      argument cannot be anything but digits, dots and colons.
 */
export async function runPingCheck(config: PingCheckConfig): Promise<CheckOutcome> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = performance.now();

  let address: string;
  let dnsMs: number;
  try {
    const dnsStartedAt = performance.now();
    const resolved = await dnsLookup(config.host, { all: true, verbatim: true });
    const first = resolved[0];
    if (!first) throw new BlockedTargetError(`no address for ${config.host}`);
    if (!config.resolve?.allowPrivateTargets) {
      for (const entry of resolved) assertAllowedIp(entry.address);
    }
    address = first.address;
    dnsMs = round(performance.now() - dnsStartedAt);
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return outcome(false, "BLOCKED_TARGET", error.reason, null, null, startedAt, null);
    }
    const classified = classifyNodeError(error, false);
    return outcome(false, classified.code, classified.detail, null, null, startedAt, null);
  }

  // Defence in depth: refuse to exec unless the address parses as a real IP.
  const parsed = parseIp(address);
  if (!parsed) {
    return outcome(false, "UNKNOWN", `resolved address ${address} is not a valid IP`, dnsMs, null, startedAt, null);
  }

  const args = buildPingArgs(address, parsed.family, timeoutMs);
  const pingStartedAt = performance.now();

  try {
    const { stdout } = await execFileAsync(args.command, args.argv, {
      timeout: timeoutMs + 1_000,
      encoding: "utf8",
    });
    const rttMs = parseRtt(stdout) ?? round(performance.now() - pingStartedAt);
    return outcome(true, null, null, dnsMs, rttMs, startedAt, address);
  } catch (error) {
    const stderr = typeof (error as { stderr?: string }).stderr === "string" ? (error as { stderr: string }).stderr : "";
    const stdout = typeof (error as { stdout?: string }).stdout === "string" ? (error as { stdout: string }).stdout : "";
    const combined = `${stdout}${stderr}`.trim();

    if (/100(\.0)?% packet loss|100% loss/i.test(combined)) {
      return outcome(false, "TCP_TIMEOUT", `no ICMP reply from ${address}`, dnsMs, null, startedAt, address);
    }
    if (/unreachable/i.test(combined)) {
      return outcome(false, "TCP_UNREACHABLE", combined.split("\n")[0] ?? "host unreachable", dnsMs, null, startedAt, address);
    }
    if ((error as { killed?: boolean }).killed === true) {
      return outcome(false, "TCP_TIMEOUT", `ping to ${address} timed out`, dnsMs, null, startedAt, address);
    }
    const classified = classifyNodeError(error, false);
    return outcome(false, classified.code, combined || classified.detail, dnsMs, null, startedAt, address);
  }
}

interface PingArgs {
  readonly command: string;
  readonly argv: readonly string[];
}

function buildPingArgs(address: string, family: 4 | 6, timeoutMs: number): PingArgs {
  const command = family === 6 ? (process.platform === "linux" ? "ping6" : "ping") : "ping";
  if (process.platform === "darwin") {
    // macOS: -W is in milliseconds, -t is the total deadline in seconds.
    const argv = ["-c", "1", "-W", String(timeoutMs), "-t", String(Math.ceil(timeoutMs / 1000))];
    if (family === 6) argv.unshift("-6");
    return { command, argv: [...argv, address] };
  }
  // Linux / BSD: -W is in seconds, -w is the total deadline.
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return { command, argv: ["-c", "1", "-W", seconds, "-w", seconds, address] };
}

/** Extracts the round-trip time from `ping` output on both macOS and Linux. */
export function parseRtt(stdout: string): number | null {
  const inline = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
  if (inline?.[1]) return round(Number(inline[1]));
  const summary = /=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(stdout);
  if (summary?.[2]) return round(Number(summary[2]));
  return null;
}

function outcome(
  ok: boolean,
  failureCode: CheckOutcome["failureCode"],
  errorDetail: string | null,
  dnsMs: number | null,
  rttMs: number | null,
  startedAt: number,
  resolvedIp: string | null,
): CheckOutcome {
  const timing: Timing = {
    dnsMs,
    tcpMs: rttMs,
    tlsMs: null,
    ttfbMs: rttMs,
    transferMs: null,
    totalMs: round(performance.now() - startedAt),
  };
  return {
    ok,
    statusCode: null,
    failureCode,
    errorDetail,
    timing,
    responseSizeBytes: null,
    resolvedIp,
    certExpiresAt: null,
    bodySnippet: null,
    responseHeaders: null,
    redirectChain: [],
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
