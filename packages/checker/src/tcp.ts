import { connect, type Socket } from "node:net";
import { Resolver } from "node:dns/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import type { CheckOutcome, Timing } from "./http";
import { assertAllowedIp, BlockedTargetError, type ResolveOptions } from "./ssrf";
import { classifyNodeError } from "./errors";

export interface TcpCheckConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
  readonly resolve?: ResolveOptions;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Raw TCP reachability. Resolves and validates the IP first (same SSRF rules
 * as HTTP), then connects to the validated address directly so there is no
 * second, unvalidated resolution inside `net.connect`.
 */
export async function runTcpCheck(config: TcpCheckConfig): Promise<CheckOutcome> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = performance.now();

  let address: string;
  let dnsMs: number;
  try {
    const resolved = await resolveHost(config.host, config.resolve);
    address = resolved.address;
    dnsMs = resolved.dnsMs;
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return outcome(false, "BLOCKED_TARGET", error.reason, timing(null, null, startedAt), null);
    }
    const classified = classifyNodeError(error, false);
    return outcome(false, classified.code, classified.detail, timing(null, null, startedAt), null);
  }

  return await new Promise<CheckOutcome>((resolve) => {
    const connectStartedAt = performance.now();
    let settled = false;

    const socket: Socket = connect({ host: address, port: config.port });

    const finish = (result: CheckOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => {
      finish(outcome(false, "TCP_TIMEOUT", `no response from ${address}:${config.port} within ${timeoutMs}ms`, timing(dnsMs, null, startedAt), address));
    });

    socket.once("connect", () => {
      const tcpMs = round(performance.now() - connectStartedAt);
      finish(outcome(true, null, null, timing(dnsMs, tcpMs, startedAt), address));
    });

    socket.once("error", (error: Error) => {
      const classified = classifyNodeError(error, false);
      finish(outcome(false, classified.code, classified.detail, timing(dnsMs, null, startedAt), address));
    });
  });
}

async function resolveHost(
  host: string,
  options: ResolveOptions | undefined,
): Promise<{ address: string; dnsMs: number }> {
  const startedAt = performance.now();
  let address: string;

  if (options?.dnsServers && options.dnsServers.length > 0) {
    const resolver = new Resolver();
    resolver.setServers([...options.dnsServers]);
    const records = await resolver.resolve4(host);
    const first = records[0];
    if (!first) throw new BlockedTargetError(`no A record for ${host}`);
    address = first;
  } else {
    const result = await dnsLookup(host, { all: true, verbatim: true });
    const first = result[0];
    if (!first) throw new BlockedTargetError(`no address for ${host}`);
    if (!options?.allowPrivateTargets) {
      for (const entry of result) assertAllowedIp(entry.address);
    }
    address = first.address;
  }

  if (!options?.allowPrivateTargets) assertAllowedIp(address);
  return { address, dnsMs: round(performance.now() - startedAt) };
}

function timing(dnsMs: number | null, tcpMs: number | null, startedAt: number): Timing {
  return {
    dnsMs,
    tcpMs,
    tlsMs: null,
    ttfbMs: null,
    transferMs: null,
    totalMs: round(performance.now() - startedAt),
  };
}

function outcome(
  ok: boolean,
  failureCode: CheckOutcome["failureCode"],
  errorDetail: string | null,
  t: Timing,
  resolvedIp: string | null,
): CheckOutcome {
  return {
    ok,
    statusCode: null,
    failureCode,
    errorDetail,
    timing: t,
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
