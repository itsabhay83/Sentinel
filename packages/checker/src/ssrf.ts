import { lookup as dnsLookup, Resolver } from "node:dns/promises";
import { ipInCidr, ipToString, parseCidr, parseIp, unwrapIpv4Mapped, type Cidr, type ParsedIp } from "./ip";

export const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Every range here is either unroutable on the public internet or points back
 * at infrastructure the probe itself can reach. `169.254.0.0/16` is the one
 * that matters most: it holds the cloud metadata endpoint (169.254.169.254)
 * that leaks instance credentials.
 */
const BLOCKED_RANGES: readonly Cidr[] = [
  parseCidr("0.0.0.0/8", "unspecified"),
  parseCidr("10.0.0.0/8", "private"),
  parseCidr("100.64.0.0/10", "carrier-grade NAT"),
  parseCidr("127.0.0.0/8", "loopback"),
  parseCidr("169.254.0.0/16", "link-local / cloud metadata"),
  parseCidr("172.16.0.0/12", "private"),
  parseCidr("192.0.0.0/24", "IETF protocol assignments"),
  parseCidr("192.0.2.0/24", "documentation"),
  parseCidr("192.168.0.0/16", "private"),
  parseCidr("198.18.0.0/15", "benchmarking"),
  parseCidr("224.0.0.0/4", "multicast"),
  parseCidr("240.0.0.0/4", "reserved"),
  parseCidr("::/128", "unspecified"),
  parseCidr("::1/128", "loopback"),
  parseCidr("fc00::/7", "unique local"),
  parseCidr("fe80::/10", "link-local"),
  parseCidr("ff00::/8", "multicast"),
];

export class BlockedTargetError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "BlockedTargetError";
    this.reason = reason;
  }
}

export function assertAllowedIp(address: string): ParsedIp {
  const parsed = parseIp(address);
  if (!parsed) throw new BlockedTargetError(`not a valid IP address: ${address}`);

  const effective = unwrapIpv4Mapped(parsed);
  for (const range of BLOCKED_RANGES) {
    if (ipInCidr(effective, range)) {
      throw new BlockedTargetError(
        `${address} is in a blocked range: ${ipToString(range)}/${range.prefix} (${range.label})`,
      );
    }
  }
  return effective;
}

export function isBlockedIp(address: string): boolean {
  try {
    assertAllowedIp(address);
    return false;
  } catch {
    return true;
  }
}

export interface ValidatedTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
  readonly dnsMs: number;
}

export interface ResolveOptions {
  readonly timeoutMs?: number;
  readonly dnsServers?: readonly string[];
  /** Escape hatch for tests that must reach a loopback fixture server. */
  readonly allowPrivateTargets?: boolean;
}

export function assertAllowedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedTargetError(`malformed URL: ${rawUrl}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedTargetError(`scheme ${url.protocol} is not allowed; only http and https`);
  }
  if (url.hostname.length === 0) {
    throw new BlockedTargetError("URL has no hostname");
  }
  return url;
}

async function resolveAddresses(
  hostname: string,
  options: ResolveOptions,
): Promise<{ address: string; family: 4 | 6 }[]> {
  const literal = parseIp(hostname.replace(/^\[|\]$/g, ""));
  if (literal) {
    return [{ address: hostname.replace(/^\[|\]$/g, ""), family: literal.family }];
  }

  if (options.dnsServers && options.dnsServers.length > 0) {
    const resolver = new Resolver({ timeout: options.timeoutMs ?? 5000, tries: 2 });
    resolver.setServers([...options.dnsServers]);
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const out: { address: string; family: 4 | 6 }[] = [];
    if (v4.status === "fulfilled") out.push(...v4.value.map((a) => ({ address: a, family: 4 as const })));
    if (v6.status === "fulfilled") out.push(...v6.value.map((a) => ({ address: a, family: 6 as const })));
    if (out.length === 0) throw new Error("NXDOMAIN");
    return out;
  }

  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
}

/**
 * Resolves the hostname and validates every returned address before any socket
 * is opened. The caller must then connect to `target.address` directly — see
 * `pinnedLookup` — so a DNS rebinding attack cannot swap in a private IP
 * between this validation and the connection.
 */
export async function validateTarget(rawUrl: string, options: ResolveOptions = {}): Promise<ValidatedTarget> {
  const url = assertAllowedUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const startedAt = performance.now();
  const addresses = await resolveAddresses(hostname, options);
  const dnsMs = performance.now() - startedAt;

  if (addresses.length === 0) {
    throw new BlockedTargetError(`${hostname} did not resolve to any address`);
  }

  if (!options.allowPrivateTargets) {
    for (const entry of addresses) {
      assertAllowedIp(entry.address);
    }
  }

  const chosen = addresses[0];
  if (!chosen) throw new BlockedTargetError(`${hostname} did not resolve to any address`);

  const port = url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  return { url, hostname, port, address: chosen.address, family: chosen.family, dnsMs };
}

export interface LookupEntry {
  address: string;
  family: number;
}

export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addressOrEntries: string | LookupEntry[],
  family?: number,
) => void;

/**
 * Node calls this instead of a real DNS query, so the socket connects to the
 * exact address we validated. Without it, Node would re-resolve the hostname
 * and could land on a different (private) IP.
 *
 * Both callback shapes are load-bearing. Node's `net.connect` has two calling
 * conventions for a custom `lookup`, and it picks between them at runtime:
 * with Happy Eyeballs on (`net.getDefaultAutoSelectFamily() === true`, the
 * default since Node 20) it passes `{ all: true }` and expects an ARRAY of
 * `{address, family}`; otherwise it expects `(err, address, family)`. Answering
 * the array call with a bare string makes Node read `addresses[0].address` as
 * undefined and throw `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`
 * — which is not our error, so it classifies as UNKNOWN and every HTTPS check
 * fails intermittently. Honour `options.all` and both paths stay pinned.
 */
export function pinnedLookup(target: ValidatedTarget) {
  return (_hostname: string, options: unknown, callback: LookupCallback): void => {
    const wantsAll =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: unknown }).all === true;

    if (wantsAll) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }

    callback(null, target.address, target.family);
  };
}
