import { describe, expect, it } from "vitest";
import {
  FAILURE_CODES,
  FAILURE_EXPLANATIONS,
  NETWORK_PATH_CODES,
  explainFailure,
  isFailureCode,
  type FailureCode,
} from "./failure-codes";

const PHASES = ["dns", "tcp", "tls", "http", "assertion", "heartbeat", "policy"] as const;

interface PrefixPhaseCase {
  readonly prefix: string;
  readonly phase: (typeof PHASES)[number];
}

/** The prefix a code carries is a promise about which phase it belongs to. */
const PREFIX_PHASES: readonly PrefixPhaseCase[] = [
  { prefix: "DNS_", phase: "dns" },
  { prefix: "TCP_", phase: "tcp" },
  { prefix: "TLS_", phase: "tls" },
  { prefix: "HTTP_", phase: "http" },
  { prefix: "ASSERT_", phase: "assertion" },
  { prefix: "HEARTBEAT_", phase: "heartbeat" },
];

describe("FAILURE_CODES", () => {
  it("lists each code exactly once", () => {
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length);
  });

  it.each(FAILURE_CODES)("%s is SCREAMING_SNAKE_CASE", (code) => {
    expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
  });

  it("keeps UNKNOWN as the catch-all of last resort", () => {
    expect(FAILURE_CODES).toContain("UNKNOWN");
    expect(FAILURE_CODES.at(-1)).toBe("UNKNOWN");
  });
});

describe("FAILURE_EXPLANATIONS", () => {
  it("explains exactly the declared codes and nothing else", () => {
    expect(Object.keys(FAILURE_EXPLANATIONS).sort()).toEqual([...FAILURE_CODES].sort());
  });

  it.each(FAILURE_CODES)("%s has a label, a declared phase, a cause and an action", (code) => {
    const explanation = FAILURE_EXPLANATIONS[code];
    expect(explanation.label.trim().length).toBeGreaterThan(0);
    expect(PHASES).toContain(explanation.phase);
    expect(explanation.explanation.trim().length).toBeGreaterThan(0);
    expect(explanation.suggestedAction.trim().length).toBeGreaterThan(0);
  });

  it.each(FAILURE_CODES)("%s says something more useful than repeating its own code", (code) => {
    const explanation = FAILURE_EXPLANATIONS[code];
    expect(explanation.explanation).not.toBe(code);
    expect(explanation.explanation.length).toBeGreaterThan(explanation.label.length);
    expect(explanation.suggestedAction).not.toBe(explanation.explanation);
  });

  it("gives every code a distinct label so two badges never read the same", () => {
    const labels = new Set(FAILURE_CODES.map((code) => FAILURE_EXPLANATIONS[code].label));
    expect(labels.size).toBe(FAILURE_CODES.length);
  });

  it.each(PREFIX_PHASES)("codes prefixed $prefix are all in the $phase phase", ({ prefix, phase }) => {
    const matching = FAILURE_CODES.filter((code) => code.startsWith(prefix));
    expect(matching.length).toBeGreaterThan(0);
    for (const code of matching) expect(FAILURE_EXPLANATIONS[code].phase).toBe(phase);
  });

  it("files the expiry advisories under the layer an operator would go and fix", () => {
    expect(FAILURE_EXPLANATIONS.CERT_EXPIRING.phase).toBe("tls");
    expect(FAILURE_EXPLANATIONS.DOMAIN_EXPIRING.phase).toBe("policy");
  });

  it("files the SSRF rejection as policy, not as a network failure", () => {
    expect(FAILURE_EXPLANATIONS.BLOCKED_TARGET.phase).toBe("policy");
  });
});

describe("explainFailure", () => {
  it.each(FAILURE_CODES)("returns the table entry for %s by identity", (code) => {
    expect(explainFailure(code)).toBe(FAILURE_EXPLANATIONS[code]);
  });
});

describe("isFailureCode", () => {
  it.each(FAILURE_CODES)("accepts %s", (code) => {
    expect(isFailureCode(code)).toBe(true);
  });

  it.each(["", "down", "http_5xx", "HTTP_5X", "HTTP_5XXX", " HTTP_5XX", "__proto__", "toString"])(
    "rejects %j",
    (value) => {
      expect(isFailureCode(value)).toBe(false);
    },
  );
});

describe("NETWORK_PATH_CODES", () => {
  it("only names codes that exist in the taxonomy", () => {
    for (const code of NETWORK_PATH_CODES) expect(isFailureCode(code)).toBe(true);
  });

  it("only names timeouts and unreachability, which a single region can see alone", () => {
    expect([...NETWORK_PATH_CODES].sort()).toEqual(["DNS_TIMEOUT", "TCP_TIMEOUT", "TCP_UNREACHABLE"]);
  });

  it("excludes origin-side failures, which every region would see together", () => {
    const originSide: readonly FailureCode[] = ["HTTP_5XX", "HTTP_4XX", "TCP_REFUSED", "TLS_EXPIRED"];
    for (const code of originSide) expect(NETWORK_PATH_CODES.has(code)).toBe(false);
  });
});
