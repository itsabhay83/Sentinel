import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { generateId, generateSessionToken, hashPassword, slugify, verifyPassword } from "./password";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PASSWORD = "correct horse battery staple";

/**
 * scrypt at N=32768 costs ~100ms per derivation, so every test that needs a
 * production-parameter hash shares these two instead of minting its own.
 */
let hashA = "";
let hashB = "";

beforeAll(async () => {
  [hashA, hashB] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
});

/** Builds a stored value at arbitrary cost parameters, the way an older row would look. */
async function storedAt(
  password: string,
  params: { N: number; r: number; p: number; keylen: number; saltBytes: number },
): Promise<string> {
  const salt = randomBytes(params.saltBytes);
  const derived = await scrypt(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", params.N, params.r, params.p, salt.toString("hex"), derived.toString("hex")].join(
    "$",
  );
}

describe("hashPassword", () => {
  it("emits the self-describing scrypt format with the production parameters", () => {
    const parts = hashA.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("32768");
    expect(parts[2]).toBe("8");
    expect(parts[3]).toBe("1");
    expect(parts[4]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[5]).toMatch(/^[0-9a-f]{128}$/);
  });

  it("salts randomly, so the same password never hashes to the same string twice", () => {
    expect(hashA).not.toBe(hashB);
    expect(hashA.split("$")[4]).not.toBe(hashB.split("$")[4]);
  });
});

describe("verifyPassword", () => {
  it("accepts the password it was derived from", async () => {
    await expect(verifyPassword(PASSWORD, hashA)).resolves.toBe(true);
  });

  it("accepts against either independently salted hash of the same password", async () => {
    await expect(verifyPassword(PASSWORD, hashB)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    await expect(verifyPassword("correct horse battery stapl", hashA)).resolves.toBe(false);
  });

  it("rejects an empty password against a real hash", async () => {
    await expect(verifyPassword("", hashA)).resolves.toBe(false);
  });

  it("reads the cost parameters back out of the stored value rather than assuming them", async () => {
    // A credential minted before the cost was raised must keep working.
    const legacy = await storedAt(PASSWORD, { N: 16_384, r: 4, p: 2, keylen: 32, saltBytes: 8 });

    expect(legacy.startsWith("scrypt$16384$4$2$")).toBe(true);
    await expect(verifyPassword(PASSWORD, legacy)).resolves.toBe(true);
    await expect(verifyPassword("wrong", legacy)).resolves.toBe(false);
  });

  it("does not confuse two stored values that differ only in their cost parameters", async () => {
    const weak = await storedAt(PASSWORD, { N: 1_024, r: 8, p: 1, keylen: 64, saltBytes: 16 });
    const strong = await storedAt(PASSWORD, { N: 4_096, r: 8, p: 1, keylen: 64, saltBytes: 16 });

    expect(weak).not.toBe(strong);
    await expect(verifyPassword(PASSWORD, weak)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, strong)).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A corrupted or truncated row must read as "wrong password", never as a 500.
// ---------------------------------------------------------------------------

interface MalformedCase {
  readonly name: string;
  readonly stored: string;
}

const MALFORMED: readonly MalformedCase[] = [
  { name: "an empty string", stored: "" },
  { name: "a bare algorithm name", stored: "scrypt" },
  { name: "a value truncated to five fields", stored: "scrypt$1024$8$1$deadbeef" },
  { name: "a value with a seventh field appended", stored: "scrypt$1024$8$1$deadbeef$abcd$extra" },
  { name: "an unknown algorithm prefix", stored: "bcrypt$1024$8$1$deadbeef$abcd" },
  { name: "a non-numeric cost", stored: "scrypt$notanumber$8$1$deadbeef$abcd" },
  { name: "a fractional cost", stored: "scrypt$1024.5$8$1$deadbeef$abcd" },
  { name: "a cost that is not a power of two", stored: "scrypt$1000$8$1$deadbeef$abcd" },
  { name: "a cost of one", stored: "scrypt$1$8$1$deadbeef$abcd" },
  { name: "a negative cost", stored: "scrypt$-1024$8$1$deadbeef$abcd" },
  { name: "a non-numeric block size", stored: "scrypt$1024$eight$1$deadbeef$abcd" },
  { name: "a non-numeric parallelism", stored: "scrypt$1024$8$one$deadbeef$abcd" },
  { name: "an empty salt", stored: "scrypt$1024$8$1$$abcd" },
  { name: "an empty hash", stored: "scrypt$1024$8$1$deadbeef$" },
  { name: "a salt that is not hex", stored: "scrypt$1024$8$1$zzzz$abcd" },
  { name: "a hash that is not hex", stored: "scrypt$1024$8$1$deadbeef$zzzz" },
  { name: "parameters scrypt itself refuses", stored: "scrypt$1024$0$1$deadbeef$abcd" },
  { name: "a bcrypt value from another system", stored: "$2b$12$abcdefghijklmnopqrstuv" },
  { name: "a plaintext password stored by mistake", stored: PASSWORD },
];

describe("verifyPassword on malformed stored values", () => {
  it.each(MALFORMED)("returns false without throwing for $name", async ({ stored }) => {
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
  });
});

describe("generateSessionToken", () => {
  it("emits 256 bits of base64url with no padding or path-unsafe characters", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("never repeats across a burst", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);
  });
});

describe("generateId", () => {
  it("emits a URL-safe identifier without a prefix", () => {
    expect(generateId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("prefixes with a single underscore separator when asked", () => {
    expect(generateId("usr")).toMatch(/^usr_[A-Za-z0-9_-]{16}$/);
  });

  it("never repeats across a burst", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId("org")));
    expect(ids.size).toBe(200);
  });
});

interface SlugCase {
  readonly input: string;
  readonly expected: string;
}

const SLUGS: readonly SlugCase[] = [
  { input: "Acme Inc.", expected: "acme-inc" },
  { input: "ACME", expected: "acme" },
  { input: "  spaced  out  ", expected: "spaced-out" },
  { input: "Ünïcôdé Nàmes", expected: "unicode-names" },
  { input: "São Paulo", expected: "sao-paulo" },
  { input: "a//b??c", expected: "a-b-c" },
  { input: "---leading and trailing---", expected: "leading-and-trailing" },
  { input: "team_42", expected: "team-42" },
];

describe("slugify", () => {
  it.each(SLUGS)("turns $input into $expected", ({ input, expected }) => {
    expect(slugify(input)).toBe(expected);
  });

  it("caps the slug at 48 characters", () => {
    expect(slugify("a".repeat(120))).toHaveLength(48);
  });

  it.each(["", "   ", "!!!", "。。。"])(
    "falls back to a random org slug when %j reduces to nothing",
    (input) => {
      expect(slugify(input)).toMatch(/^org-[0-9a-f]{8}$/);
    },
  );

  it("gives two empty inputs different fallbacks", () => {
    expect(slugify("")).not.toBe(slugify(""));
  });
});
