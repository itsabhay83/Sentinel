import { describe, expect, it } from "vitest";
import {
  constantTimeEquals,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  generateApiKey,
  generateToken,
  hashApiKey,
  hashToken,
  signWebhook,
  verifyWebhook,
} from "./crypto";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("encryptSecret / decryptSecret", () => {
  it.each([
    ["ascii", "Bearer sk_test_1234567890"],
    ["empty string", ""],
    ["unicode", "パスワード — clé 🔐"],
    ["json-ish", '{"authorization":"Bearer x.y.z"}'],
    ["long", "x".repeat(8192)],
  ])("round-trips %s", (_label, plaintext) => {
    expect(decryptSecret(encryptSecret(plaintext, KEY_A), KEY_A)).toBe(plaintext);
  });

  it("emits the versioned four-part wire format with a 96-bit nonce", () => {
    const parts = encryptSecret("secret", KEY_A).split(".");

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toMatch(/^[0-9a-f]{24}$/);
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never reuses a nonce, so identical plaintexts are not linkable", () => {
    const first = encryptSecret("same", KEY_A);
    const second = encryptSecret("same", KEY_A);

    expect(first).not.toBe(second);
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
  });

  it("rejects a payload decrypted with the wrong key", () => {
    const payload = encryptSecret("secret", KEY_A);
    expect(() => decryptSecret(payload, KEY_B)).toThrow();
  });

  it("rejects a swapped ciphertext under a valid auth tag", () => {
    const [, iv, tag] = encryptSecret("original", KEY_A).split(".");
    const forged = encryptSecret("attacker-controlled", KEY_A).split(".")[3];

    expect(() => decryptSecret(`v1.${iv}.${tag}.${forged}`, KEY_A)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const parts = encryptSecret("original", KEY_A).split(".");
    const tag = parts[2] as string;
    const flipped = `${tag.slice(0, -1)}${tag.endsWith("0") ? "1" : "0"}`;

    expect(() => decryptSecret(`v1.${parts[1]}.${flipped}.${parts[3]}`, KEY_A)).toThrow();
  });

  it.each([
    ["too few parts", "v1.aabb.ccdd"],
    ["an unknown version", "v2.aabb.ccdd.eeff"],
    ["no structure at all", "not-a-payload"],
  ])("refuses %s", (_label, payload) => {
    expect(() => decryptSecret(payload, KEY_A)).toThrow(/Malformed encrypted payload/);
  });

  it.each([
    ["short", "abc"],
    ["non-hex", "z".repeat(64)],
    ["empty", ""],
  ])("refuses a %s encryption key", (_label, key) => {
    expect(() => encryptSecret("secret", key)).toThrow(/64 hex characters/);
  });
});

describe("encryptJson / decryptJson", () => {
  it("round-trips structured values", () => {
    const headers = { authorization: "Bearer token", "x-trace": "abc" };
    const payload = encryptJson(headers, KEY_A);

    expect(payload).not.toBeNull();
    expect(decryptJson(payload, KEY_A, {})).toEqual(headers);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
  ])("stores %s as null rather than encrypting nothing", (_label, value) => {
    expect(encryptJson(value, KEY_A)).toBeNull();
  });

  it("returns the fallback when there is nothing stored", () => {
    expect(decryptJson(null, KEY_A, { fallback: true })).toEqual({ fallback: true });
  });
});

describe("signWebhook / verifyWebhook", () => {
  const body = '{"event":"monitor.down"}';
  const secret = "whsec_test";

  it("is deterministic for the same timestamp and body", () => {
    expect(signWebhook(body, secret, 1_700_000_000)).toBe(signWebhook(body, secret, 1_700_000_000));
  });

  it("binds the signature to the timestamp, not just the body", () => {
    expect(signWebhook(body, secret, 1_700_000_000)).not.toBe(
      signWebhook(body, secret, 1_700_000_001),
    );
  });

  it("accepts a fresh, correctly signed payload", () => {
    const ts = nowSeconds();
    expect(verifyWebhook(body, secret, ts, signWebhook(body, secret, ts))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const ts = nowSeconds();
    expect(verifyWebhook(body, secret, ts, signWebhook(body, "other", ts))).toBe(false);
  });

  it("rejects a modified body", () => {
    const ts = nowSeconds();
    expect(verifyWebhook('{"event":"monitor.up"}', secret, ts, signWebhook(body, secret, ts))).toBe(
      false,
    );
  });

  it("rejects a replayed payload older than the tolerance window", () => {
    const ts = nowSeconds() - 301;
    expect(verifyWebhook(body, secret, ts, signWebhook(body, secret, ts))).toBe(false);
  });

  it("rejects a timestamp too far in the future", () => {
    const ts = nowSeconds() + 301;
    expect(verifyWebhook(body, secret, ts, signWebhook(body, secret, ts))).toBe(false);
  });

  it("honours a caller-supplied tolerance", () => {
    const ts = nowSeconds() - 400;
    expect(verifyWebhook(body, secret, ts, signWebhook(body, secret, ts), 600)).toBe(true);
  });

  it("returns false instead of throwing on a truncated signature", () => {
    const ts = nowSeconds();
    expect(verifyWebhook(body, secret, ts, "deadbeef")).toBe(false);
  });
});

describe("hashApiKey / generateApiKey", () => {
  it("is deterministic for a given secret", () => {
    expect(hashApiKey("sk_live_abc", "secret")).toBe(hashApiKey("sk_live_abc", "secret"));
  });

  it("produces a different digest under a different secret", () => {
    expect(hashApiKey("sk_live_abc", "secret-a")).not.toBe(hashApiKey("sk_live_abc", "secret-b"));
  });

  it("refuses an empty secret rather than silently hashing with nothing", () => {
    expect(() => hashApiKey("sk_live_abc", "")).toThrow(/must not be empty/);
  });

  it("mints a prefixed key whose stored hash matches the plaintext", () => {
    const { key, hashed } = generateApiKey("secret");

    expect(key.startsWith("sk_live_")).toBe(true);
    expect(hashed).toBe(hashApiKey(key, "secret"));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints unpredictable keys", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey("secret").key));
    expect(keys.size).toBe(50);
  });
});

describe("hashToken", () => {
  it("matches the standard SHA-256 digest so digests stay portable", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and collision-free across distinct tokens", () => {
    expect(hashToken("token")).toBe(hashToken("token"));
    expect(hashToken("token")).not.toBe(hashToken("token "));
  });
});

describe("constantTimeEquals", () => {
  it.each([
    ["identical strings", "abc123", "abc123", true],
    ["differing strings of equal length", "abc123", "abc124", false],
    ["strings of differing length", "abc", "abcd", false],
    ["empty strings", "", "", true],
    ["multi-byte characters", "clé", "clé", true],
  ])("%s", (_label, left, right, expected) => {
    expect(constantTimeEquals(left, right)).toBe(expected);
  });
});

describe("generateToken", () => {
  it("defaults to 16 bytes of base64url entropy", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(16);
  });

  it("honours a requested byte length", () => {
    expect(Buffer.from(generateToken(32), "base64url")).toHaveLength(32);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });
});
