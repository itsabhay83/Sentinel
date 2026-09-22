import {
  runDnsCheck,
  runFlowCheck,
  runHttpCheck,
  runTcpCheck,
  runPingCheck,
  type CheckOutcome,
  type DnsRecordType,
  type FlowStep,
} from "@sentinel/checker";
import type { CheckJob } from "@sentinel/shared";

const DNS_RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);

export interface ResolvedCheckJob extends CheckJob {
  headers: Record<string, string>;
  body: string | null;
  flowSteps: FlowStep[];
}

function parseTcpTarget(raw: string): { host: string; port: number } {
  const normalized = raw.includes("://") ? raw : `tcp://${raw}`;
  const url = new URL(normalized);
  const port = Number.parseInt(url.port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`TCP monitor target must include a port: ${raw}`);
  }
  return { host: url.hostname, port };
}

function parseHostTarget(raw: string): { host: string; params: URLSearchParams } {
  const normalized = raw.includes("://") ? raw : `dns://${raw}`;
  const url = new URL(normalized);
  return { host: url.hostname, params: url.searchParams };
}

export async function runCheck(job: ResolvedCheckJob): Promise<CheckOutcome> {
  switch (job.type) {
    case "http":
      return runHttpCheck({
        url: job.url,
        method: job.method,
        headers: job.headers,
        body: job.body,
        timeoutMs: job.timeoutMs,
        followRedirects: job.followRedirects,
        maxRedirects: job.maxRedirects,
        expectedStatusCodes: job.expectedStatusCodes,
        assertions: job.assertions,
      });

    case "tcp": {
      const { host, port } = parseTcpTarget(job.url);
      return runTcpCheck({ host, port, timeoutMs: job.timeoutMs });
    }

    case "ping": {
      const { host } = parseHostTarget(job.url);
      return runPingCheck({ host, timeoutMs: job.timeoutMs });
    }

    case "dns": {
      const { host, params } = parseHostTarget(job.url);
      const requested = (params.get("type") ?? "A").toUpperCase();
      const recordType = (
        DNS_RECORD_TYPES.has(requested) ? requested : "A"
      ) as DnsRecordType;
      return runDnsCheck({
        host,
        recordType,
        expectedValue: params.get("expect"),
        timeoutMs: job.timeoutMs,
      });
    }

    case "flow": {
      const result = await runFlowCheck({
        steps: job.flowSteps,
        timeoutMs: job.timeoutMs,
      });
      const lastStep = result.steps.at(-1);
      return {
        ok: result.ok,
        statusCode: lastStep?.outcome.statusCode ?? null,
        failureCode: result.failureCode,
        errorDetail: result.failedStep
          ? `step "${result.failedStep}": ${result.errorDetail ?? "failed"}`
          : result.errorDetail,
        timing: {
          dnsMs: null,
          tcpMs: null,
          tlsMs: null,
          ttfbMs: null,
          transferMs: null,
          totalMs: result.totalMs,
        },
        responseSizeBytes: null,
        resolvedIp: null,
        certExpiresAt: null,
        bodySnippet: JSON.stringify(
          result.steps.map((step) => ({
            name: step.name,
            ok: step.outcome.ok,
            status: step.outcome.statusCode,
            ms: step.outcome.timing.totalMs,
          })),
        ),
        responseHeaders: null,
        redirectChain: [],
      };
    }

    // Heartbeats are inbound: the monitored job pings us. The scheduler detects
    // a missed ping directly, so no probe ever dials out for one.
    case "heartbeat":
      throw new Error("heartbeat monitors are never dispatched to probes");

    default: {
      const exhaustive: never = job.type;
      throw new Error(`unsupported monitor type: ${String(exhaustive)}`);
    }
  }
}
