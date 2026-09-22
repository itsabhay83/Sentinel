import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import type { FailureCode } from "@sentinel/shared";
import { evaluateAssertions, type Assertion } from "./assertions";
import { BlockedTargetError, pinnedLookup, validateTarget, type ResolveOptions } from "./ssrf";
import { classifyNodeError } from "./errors";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const BODY_SNIPPET_BYTES = 8 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS_CAP = 5;

export interface Timing {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  transferMs: number | null;
  totalMs: number;
}

export interface CheckOutcome {
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly failureCode: FailureCode | null;
  readonly errorDetail: string | null;
  readonly timing: Timing;
  readonly responseSizeBytes: number | null;
  readonly resolvedIp: string | null;
  readonly certExpiresAt: Date | null;
  readonly bodySnippet: string | null;
  readonly responseHeaders: Record<string, string> | null;
  readonly redirectChain: readonly string[];
}

export interface HttpCheckConfig {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | null;
  readonly timeoutMs?: number;
  readonly followRedirects?: boolean;
  readonly maxRedirects?: number;
  readonly expectedStatusCodes?: readonly number[];
  readonly assertions?: readonly Assertion[];
  readonly resolve?: ResolveOptions;
  readonly userAgent?: string;
}

interface HopResult {
  readonly response: IncomingMessage;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly timing: Timing;
  readonly resolvedIp: string;
  readonly certExpiresAt: Date | null;
}

function emptyTiming(): Timing {
  return { dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null, transferMs: null, totalMs: 0 };
}

function statusIsExpected(status: number, expected: readonly number[] | undefined): boolean {
  if (!expected || expected.length === 0) return status >= 200 && status < 400;
  return expected.includes(status);
}

function failureForStatus(status: number): FailureCode {
  if (status >= 500) return "HTTP_5XX";
  if (status >= 400) return "HTTP_4XX";
  return "HTTP_5XX";
}

class BodyTooLargeError extends Error {
  constructor() {
    super("response body exceeded 2 MB cap");
    this.name = "BodyTooLargeError";
  }
}

async function performHop(
  rawUrl: string,
  config: HttpCheckConfig,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HopResult> {
  const target = await validateTarget(rawUrl, config.resolve);
  const timing = emptyTiming();
  timing.dnsMs = Math.round(target.dnsMs * 100) / 100;

  const isTls = target.url.protocol === "https:";
  const requestFn = isTls ? httpsRequest : httpRequest;
  const startedAt = performance.now();
  let socketAt = 0;
  let connectAt = 0;

  return await new Promise<HopResult>((resolve, reject) => {
    const req = requestFn(
      {
        protocol: target.url.protocol,
        host: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: config.method ?? "GET",
        headers: {
          host: target.url.host,
          "user-agent": config.userAgent ?? "Sentinel/1.0 (+https://sentinel.dev/bot)",
          "accept-encoding": "identity",
          connection: "close",
          ...config.headers,
        },
        lookup: pinnedLookup(target),
        servername: isTls ? target.hostname : undefined,
        rejectUnauthorized: true,
        timeout: timeoutMs,
        signal,
      },
      (res: IncomingMessage) => {
        timing.ttfbMs = Math.round((performance.now() - startedAt) * 100) / 100;
        const firstByteAt = performance.now();

        const chunks: Buffer[] = [];
        let received = 0;
        let kept = 0;
        let truncated = false;

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BODY_BYTES) {
            truncated = true;
            res.destroy(new BodyTooLargeError());
            return;
          }
          if (kept < BODY_SNIPPET_BYTES) {
            chunks.push(chunk);
            kept += chunk.length;
          }
        });

        res.on("end", () => {
          timing.transferMs = Math.round((performance.now() - firstByteAt) * 100) / 100;
          timing.totalMs = Math.round((performance.now() - startedAt) * 100) / 100;
          resolve({
            response: res,
            body: Buffer.concat(chunks),
            truncated,
            totalBytes: received,
            timing,
            resolvedIp: target.address,
            certExpiresAt: readCertExpiry(req.socket),
          });
        });

        res.on("error", (error: Error) => reject(error));
      },
    );

    req.on("socket", (socket: Socket) => {
      socketAt = performance.now();
      socket.on("lookup", () => {});
      socket.on("connect", () => {
        connectAt = performance.now();
        timing.tcpMs = Math.round((connectAt - socketAt) * 100) / 100;
      });
      socket.on("secureConnect", () => {
        timing.tlsMs = Math.round((performance.now() - connectAt) * 100) / 100;
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }));
    });

    req.on("error", (error: Error) => reject(error));

    if (config.body !== undefined && config.body !== null && config.body.length > 0) {
      req.write(config.body);
    }
    req.end();
  });
}

function readCertExpiry(socket: Socket | null): Date | null {
  if (!socket) return null;
  const tlsSocket = socket as TLSSocket;
  if (typeof tlsSocket.getPeerCertificate !== "function") return null;
  const cert = tlsSocket.getPeerCertificate();
  if (!cert || typeof cert.valid_to !== "string" || cert.valid_to.length === 0) return null;
  const parsed = new Date(cert.valid_to);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function collectHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export async function runHttpCheck(config: HttpCheckConfig): Promise<CheckOutcome> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = Math.min(config.maxRedirects ?? MAX_REDIRECTS_CAP, MAX_REDIRECTS_CAP);
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  const redirectChain: string[] = [];
  const seen = new Set<string>();
  let currentUrl = config.url;
  const aggregate = emptyTiming();

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (seen.has(currentUrl)) {
        return failure("HTTP_REDIRECT_LOOP", `redirect loop revisiting ${currentUrl}`, aggregate, startedAt, redirectChain);
      }
      seen.add(currentUrl);

      const result = await performHop(currentUrl, config, timeoutMs, controller.signal);
      mergeTiming(aggregate, result.timing);

      const status = result.response.statusCode ?? 0;
      const headers = collectHeaders(result.response);
      const isRedirect = status >= 300 && status < 400 && typeof result.response.headers.location === "string";

      if (isRedirect && (config.followRedirects ?? true)) {
        if (hop === maxRedirects) {
          return failure("HTTP_REDIRECT_LOOP", `exceeded ${maxRedirects} redirects`, aggregate, startedAt, redirectChain);
        }
        const location = result.response.headers.location as string;
        currentUrl = new URL(location, currentUrl).toString();
        redirectChain.push(currentUrl);
        continue;
      }

      if (result.truncated) {
        return {
          ok: false,
          statusCode: status,
          failureCode: "HTTP_TOO_LARGE",
          errorDetail: `response exceeded ${MAX_BODY_BYTES} bytes`,
          timing: finalize(aggregate, startedAt),
          responseSizeBytes: result.totalBytes,
          resolvedIp: result.resolvedIp,
          certExpiresAt: result.certExpiresAt,
          bodySnippet: null,
          responseHeaders: headers,
          redirectChain,
        };
      }

      const bodyText = result.body.toString("utf8");
      const timing = finalize(aggregate, startedAt);

      if (!statusIsExpected(status, config.expectedStatusCodes)) {
        return {
          ok: false,
          statusCode: status,
          failureCode: failureForStatus(status),
          errorDetail: `unexpected status ${status}`,
          timing,
          responseSizeBytes: result.totalBytes,
          resolvedIp: result.resolvedIp,
          certExpiresAt: result.certExpiresAt,
          bodySnippet: bodyText.slice(0, 2000),
          responseHeaders: headers,
          redirectChain,
        };
      }

      const assertionFailure = evaluateAssertions(config.assertions ?? [], {
        body: bodyText,
        headers,
        statusCode: status,
        responseTimeMs: timing.totalMs,
      });

      if (assertionFailure) {
        return {
          ok: false,
          statusCode: status,
          failureCode: assertionFailure.code,
          errorDetail: assertionFailure.detail,
          timing,
          responseSizeBytes: result.totalBytes,
          resolvedIp: result.resolvedIp,
          certExpiresAt: result.certExpiresAt,
          bodySnippet: bodyText.slice(0, 2000),
          responseHeaders: headers,
          redirectChain,
        };
      }

      return {
        ok: true,
        statusCode: status,
        failureCode: null,
        errorDetail: null,
        timing,
        responseSizeBytes: result.totalBytes,
        resolvedIp: result.resolvedIp,
        certExpiresAt: result.certExpiresAt,
        bodySnippet: bodyText.slice(0, 2000),
        responseHeaders: headers,
        redirectChain,
      };
    }

    return failure("HTTP_REDIRECT_LOOP", `exceeded ${maxRedirects} redirects`, aggregate, startedAt, redirectChain);
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return failure("BLOCKED_TARGET", error.reason, aggregate, startedAt, redirectChain);
    }
    if (error instanceof BodyTooLargeError) {
      return failure("HTTP_TOO_LARGE", error.message, aggregate, startedAt, redirectChain);
    }
    const classified = classifyNodeError(error, controller.signal.aborted);
    return failure(classified.code, classified.detail, aggregate, startedAt, redirectChain);
  } finally {
    clearTimeout(hardStop);
  }
}

function mergeTiming(target: Timing, hop: Timing): void {
  target.dnsMs = (target.dnsMs ?? 0) + (hop.dnsMs ?? 0);
  target.tcpMs = (target.tcpMs ?? 0) + (hop.tcpMs ?? 0);
  if (hop.tlsMs !== null) target.tlsMs = (target.tlsMs ?? 0) + hop.tlsMs;
  target.ttfbMs = (target.ttfbMs ?? 0) + (hop.ttfbMs ?? 0);
  target.transferMs = (target.transferMs ?? 0) + (hop.transferMs ?? 0);
}

function finalize(timing: Timing, startedAt: number): Timing {
  return { ...timing, totalMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}

function failure(
  code: FailureCode,
  detail: string,
  timing: Timing,
  startedAt: number,
  redirectChain: readonly string[],
): CheckOutcome {
  return {
    ok: false,
    statusCode: null,
    failureCode: code,
    errorDetail: detail,
    timing: finalize(timing, startedAt),
    responseSizeBytes: null,
    resolvedIp: null,
    certExpiresAt: null,
    bodySnippet: null,
    responseHeaders: null,
    redirectChain,
  };
}
