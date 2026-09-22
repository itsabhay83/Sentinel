import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt parameters. N=2^15 keeps a single hash around 100ms on a laptop core,
 * which is the usual sweet spot between "annoying to brute force" and "does not
 * stall the request". maxmem must be raised explicitly because Node's default
 * 32MB ceiling rejects N=32768 with r=8.
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const PREFIX = "scrypt";

/**
 * Hash a plaintext password into a self-describing string:
 *   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 * Encoding the cost parameters inline means we can raise them later without
 * invalidating existing credentials — verify reads them back from the stored value.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/**
 * Constant-time verification. Returns false (never throws) for malformed stored
 * values so a corrupted row degrades to "wrong password" instead of a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [prefix, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  if (prefix !== PREFIX) return false;

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n <= 1 || (n & (n - 1)) !== 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex ?? "", "hex");
    expected = Buffer.from(hashHex ?? "", "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Session tokens are opaque 256-bit random strings; never derived from user data. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Stable, URL-safe identifier used for text primary keys (users, orgs, members). */
export function generateId(prefix?: string): string {
  const raw = randomBytes(12).toString("base64url");
  return prefix ? `${prefix}_${raw}` : raw;
}

/** Turn "Acme Inc." into "acme-inc"; falls back to a random suffix when empty. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base.length > 0 ? base : `org-${randomBytes(4).toString("hex")}`;
}
