import { Resolver } from "node:dns/promises";
import type { CheckOutcome, Timing } from "./http";
import { classifyNodeError } from "./errors";

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";

export interface DnsCheckConfig {
  readonly host: string;
  readonly recordType?: DnsRecordType;
  /** When set, the resolved records must contain this value. */
  readonly expectedValue?: string | null;
  readonly timeoutMs?: number;
  readonly dnsServers?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * DNS-only monitor: does the name resolve at all, and does it resolve to what
 * the user expects? No socket is opened, so there is no SSRF surface here.
 */
export async function runDnsCheck(config: DnsCheckConfig): Promise<CheckOutcome> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const recordType = config.recordType ?? "A";
  const startedAt = performance.now();

  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (config.dnsServers && config.dnsServers.length > 0) {
    resolver.setServers([...config.dnsServers]);
  }

  try {
    const records = await resolveRecords(resolver, config.host, recordType);
    const dnsMs = round(performance.now() - startedAt);

    if (records.length === 0) {
      return outcome(false, "DNS_NXDOMAIN", `${recordType} lookup for ${config.host} returned no records`, dnsMs, startedAt, null);
    }

    if (config.expectedValue) {
      const matched = records.some((record) => record.includes(config.expectedValue as string));
      if (!matched) {
        return outcome(
          false,
          "ASSERT_KEYWORD_MISSING",
          `${recordType} records [${records.join(", ")}] do not contain "${config.expectedValue}"`,
          dnsMs,
          startedAt,
          records[0] ?? null,
        );
      }
    }

    return outcome(true, null, null, dnsMs, startedAt, recordType === "A" ? (records[0] ?? null) : null);
  } catch (error) {
    const classified = classifyNodeError(error, false);
    return outcome(false, classified.code, classified.detail, round(performance.now() - startedAt), startedAt, null);
  }
}

async function resolveRecords(resolver: Resolver, host: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case "A":
      return await resolver.resolve4(host);
    case "AAAA":
      return await resolver.resolve6(host);
    case "CNAME":
      return await resolver.resolveCname(host);
    case "NS":
      return await resolver.resolveNs(host);
    case "TXT": {
      const records = await resolver.resolveTxt(host);
      return records.map((chunks) => chunks.join(""));
    }
    case "MX": {
      const records = await resolver.resolveMx(host);
      return records.map((record) => `${record.priority} ${record.exchange}`);
    }
    default: {
      const exhaustive: never = type;
      throw new Error(`unsupported record type ${String(exhaustive)}`);
    }
  }
}

function outcome(
  ok: boolean,
  failureCode: CheckOutcome["failureCode"],
  errorDetail: string | null,
  dnsMs: number,
  startedAt: number,
  resolvedIp: string | null,
): CheckOutcome {
  const timing: Timing = {
    dnsMs,
    tcpMs: null,
    tlsMs: null,
    ttfbMs: null,
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
