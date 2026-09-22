import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import { getServerEnv } from "@sentinel/shared/env";
import { constantTimeEquals, decryptSecret, encryptSecret } from "@sentinel/shared/server";

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), hand-rolled on `node:crypto`.
 *
 * The algorithm is forty lines and frozen by the RFC, while every library that
 * wraps it is a supply-chain dependency sitting directly on the authentication
 * path. SHA-1 is not a weakness here: HMAC-SHA1 has no practical break, and it
 * is what every authenticator app defaults to.
 */

/** RFC 4648 §6, uppercase, no padding — the alphabet authenticator apps expect. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const TOTP_DIGITS = 6;
const TOTP_STEP_SECONDS = 30;
/** One step either side of now, which is the drift tolerance RFC 6238 §5.2 suggests. */
const TOTP_DRIFT_STEPS = 1;
const SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5;

export function base32Encode(bytes: Buffer): string {
  let buffered = 0;
  let bits = 0;
  let output = "";

  for (const byte of bytes) {
    buffered = (buffered << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((buffered >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET.charAt((buffered << (5 - bits)) & 31);

  return output;
}

export function base32Decode(input: string): Buffer {
  const normalised = input.toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
  const bytes: number[] = [];
  let buffered = 0;
  let bits = 0;

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("Secret is not valid base32");
    buffered = (buffered << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffered >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * RFC 4226 §5.4 dynamic truncation: the low nibble of the final byte picks the
 * 4-byte window, so the code depends on the whole digest rather than a fixed
 * slice of it. The top bit is masked off to keep the value positive.
 */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fff_ffff;

  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function verifyTotp(base32Secret: string, code: string, atMs: number = Date.now()): boolean {
  const submitted = code.replace(/\D/g, "");
  if (submitted.length !== TOTP_DIGITS) return false;

  let secret: Buffer;
  try {
    secret = base32Decode(base32Secret);
  } catch {
    return false;
  }

  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
    if (constantTimeEquals(hotp(secret, counter + drift), submitted)) return true;
  }
  return false;
}

export function otpauthUri(email: string, base32Secret: string): string {
  const issuer = getServerEnv().MFA_ISSUER;
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?${params.toString()}`;
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomBytes(RECOVERY_CODE_BYTES).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function normaliseRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function encryptMfaSecret(base32Secret: string): string {
  return encryptSecret(base32Secret, getServerEnv().ENCRYPTION_KEY);
}

export function decryptMfaSecret(ciphertext: string): string {
  return decryptSecret(ciphertext, getServerEnv().ENCRYPTION_KEY);
}
