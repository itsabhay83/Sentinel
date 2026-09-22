import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Monitor request headers and bodies routinely contain API tokens, so they are
 * encrypted at rest with AES-256-GCM. Key comes from env, never from code.
 *
 * Wire format: `v1.<iv-hex>.<authTag-hex>.<ciphertext-base64>`
 * Versioned so the scheme can rotate without a migration guess.
 */

const VERSION = "v1";
const IV_BYTES = 12; // GCM standard nonce length
const ALGORITHM = "aes-256-gcm";

function keyFromHex(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  }
  return Buffer.from(hexKey, "hex");
}

export function encryptSecret(plaintext: string, hexKey: string): string {
  const key = keyFromHex(hexKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("hex")}.${authTag.toString("hex")}.${ciphertext.toString("base64")}`;
}

export function decryptSecret(payload: string, hexKey: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted payload");
  }
  const [, ivHex, tagHex, ciphertextB64] = parts as [string, string, string, string];
  const key = keyFromHex(hexKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Encrypts a JSON-serialisable value; returns null for empty input. */
export function encryptJson(value: unknown, hexKey: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return null;
  return encryptSecret(JSON.stringify(value), hexKey);
}

export function decryptJson<T>(payload: string | null, hexKey: string, fallback: T): T {
  if (!payload) return fallback;
  return JSON.parse(decryptSecret(payload, hexKey)) as T;
}

// ---------------------------------------------------------------------------
// Webhook signing — HMAC-SHA256 over `timestamp.body`, sent as X-Sentinel-Signature.
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = "X-Sentinel-Signature";
export const TIMESTAMP_HEADER = "X-Sentinel-Timestamp";

export function signWebhook(body: string, secret: string, timestampSeconds: number): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
}

/**
 * Constant-time verification with a replay window. Exposed so the documented
 * verification snippet users copy is the exact code Sentinel runs.
 */
export function verifyWebhook(
  body: string,
  secret: string,
  timestampSeconds: number,
  signature: string,
  toleranceSeconds = 300,
): boolean {
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (age > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(body, secret, timestampSeconds), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/**
 * API keys are stored hashed; the plaintext is shown to the user exactly once.
 * The HMAC secret is injected rather than hardcoded so that a source-code leak
 * does not let an attacker match hashes against candidate keys offline.
 */
export function hashApiKey(key: string, secret: string): string {
  if (secret.length === 0) throw new Error("API key HMAC secret must not be empty");
  return createHmac("sha256", secret).update(key).digest("hex");
}

export function generateApiKey(secret: string): { key: string; hashed: string } {
  const key = `sk_live_${randomBytes(24).toString("base64url")}`;
  return { key, hashed: hashApiKey(key, secret) };
}

/** Single-use credentials (reset tokens, invites, heartbeats) are stored as SHA-256 digests. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function generateToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}
