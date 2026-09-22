import { isIP } from "node:net";

export type IpFamily = 4 | 6;

export interface ParsedIp {
  readonly family: IpFamily;
  readonly bytes: Uint8Array;
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    if (part === undefined || part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  let text = value;
  const zoneIndex = text.indexOf("%");
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);

  let tail: Uint8Array = new Uint8Array(0);
  const lastColon = text.lastIndexOf(":");
  const trailing = lastColon === -1 ? "" : text.slice(lastColon + 1);
  if (trailing.includes(".")) {
    const embedded = parseIpv4(trailing);
    if (!embedded) return null;
    tail = embedded;
    text = text.slice(0, lastColon + 1) + "0:0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const readGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const out: number[] = [];
    for (const group of segment.split(":")) {
      if (group.length === 0 || group.length > 4) return null;
      if (!/^[0-9a-fA-F]+$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = readGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? readGroups(halves[1] ?? "") : null;
  if (head === null) return null;
  if (halves.length === 2 && rest === null) return null;

  const groups: number[] =
    halves.length === 2
      ? [...head, ...new Array<number>(8 - head.length - (rest?.length ?? 0)).fill(0), ...(rest ?? [])]
      : head;

  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i] ?? 0;
    bytes[i * 2] = (group >> 8) & 0xff;
    bytes[i * 2 + 1] = group & 0xff;
  }
  if (tail.length === 4) bytes.set(tail, 12);
  return bytes;
}

export function parseIp(value: string): ParsedIp | null {
  const family = isIP(value);
  if (family === 4) {
    const bytes = parseIpv4(value);
    return bytes ? { family: 4, bytes } : null;
  }
  if (family === 6) {
    const bytes = parseIpv6(value);
    return bytes ? { family: 6, bytes } : null;
  }
  return null;
}

/**
 * An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) reaches the same host as the
 * bare IPv4 address, so it must be unwrapped before range checks or it becomes
 * a trivial bypass of the v4 blocklist.
 */
export function unwrapIpv4Mapped(ip: ParsedIp): ParsedIp {
  if (ip.family !== 6) return ip;
  const b = ip.bytes;
  const prefixIsZero = b.subarray(0, 10).every((byte) => byte === 0);
  if (prefixIsZero && b[10] === 0xff && b[11] === 0xff) {
    return { family: 4, bytes: b.subarray(12, 16) };
  }
  if (prefixIsZero && b[10] === 0 && b[11] === 0) {
    const v4 = b.subarray(12, 16);
    const isUnspecifiedOrLoopback = v4.every((byte) => byte === 0) || (v4[0] === 0 && v4[3] === 1);
    if (!isUnspecifiedOrLoopback) return { family: 4, bytes: v4 };
  }
  return ip;
}

export function ipToString(ip: ParsedIp): string {
  if (ip.family === 4) return Array.from(ip.bytes).join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((ip.bytes[i] ?? 0) << 8) | (ip.bytes[i + 1] ?? 0)).toString(16));
  }
  return groups.join(":");
}

export interface Cidr {
  readonly family: IpFamily;
  readonly bytes: Uint8Array;
  readonly prefix: number;
  readonly label: string;
}

export function parseCidr(notation: string, label = notation): Cidr {
  const [address, prefixText] = notation.split("/");
  if (address === undefined || prefixText === undefined) {
    throw new Error(`invalid CIDR: ${notation}`);
  }
  const parsed = parseIp(address);
  if (!parsed) throw new Error(`invalid CIDR address: ${notation}`);
  const prefix = Number(prefixText);
  const maxPrefix = parsed.family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`invalid CIDR prefix: ${notation}`);
  }
  return { family: parsed.family, bytes: parsed.bytes, prefix, label };
}

export function ipInCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.family !== cidr.family) return false;
  const fullBytes = Math.floor(cidr.prefix / 8);
  const remainingBits = cidr.prefix % 8;

  for (let i = 0; i < fullBytes; i += 1) {
    if (ip.bytes[i] !== cidr.bytes[i]) return false;
  }
  if (remainingBits === 0) return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((ip.bytes[fullBytes] ?? 0) & mask) === ((cidr.bytes[fullBytes] ?? 0) & mask);
}
