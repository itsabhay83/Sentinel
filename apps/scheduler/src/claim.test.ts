import { describe, expect, it } from "vitest";
import { encryptJson } from "@sentinel/shared/server";

import { resolveFlowSteps, type StoredFlowStep } from "./claim";

/** Mirrors ENCRYPTION_KEY pinned in vitest.config.ts. */
const KEY = "0".repeat(64);

function step(overrides: Partial<StoredFlowStep> = {}): StoredFlowStep {
  return {
    name: "login",
    url: "https://api.example.test/login",
    method: "POST",
    headersEncrypted: null,
    bodyEncrypted: null,
    expectedStatusCodes: null,
    extract: null,
    ...overrides,
  };
}

describe("resolveFlowSteps", () => {
  it("unwraps the per-step header ciphertext", () => {
    const headers = { authorization: "Bearer secret-token" };

    const [resolved] = resolveFlowSteps(
      [step({ headersEncrypted: encryptJson(headers, KEY) })],
      KEY,
    );

    expect(resolved?.headers).toEqual(headers);
  });

  it("unwraps the body out of its envelope rather than handing the envelope on", () => {
    const [resolved] = resolveFlowSteps(
      [step({ bodyEncrypted: encryptJson({ value: '{"user":"demo"}' }, KEY) })],
      KEY,
    );

    expect(resolved?.body).toBe('{"user":"demo"}');
  });

  it("never leaves ciphertext on the resolved step", () => {
    const [resolved] = resolveFlowSteps(
      [step({ headersEncrypted: encryptJson({ authorization: "Bearer x" }, KEY) })],
      KEY,
    );

    expect(resolved).not.toHaveProperty("headersEncrypted");
    expect(resolved).not.toHaveProperty("bodyEncrypted");
  });

  it("substitutes empty collections for a step that stored nothing", () => {
    const [resolved] = resolveFlowSteps([step()], KEY);

    expect(resolved).toEqual({
      name: "login",
      url: "https://api.example.test/login",
      method: "POST",
      headers: {},
      body: null,
      expectedStatusCodes: [],
      extract: {},
    });
  });

  it("carries the stored status codes and extractions through untouched", () => {
    const [resolved] = resolveFlowSteps(
      [step({ expectedStatusCodes: [200, 201], extract: { token: "$.token" } })],
      KEY,
    );

    expect(resolved?.expectedStatusCodes).toEqual([200, 201]);
    expect(resolved?.extract).toEqual({ token: "$.token" });
  });

  it("preserves step order, which is the whole meaning of a flow", () => {
    const resolved = resolveFlowSteps(
      [step({ name: "login" }), step({ name: "search" }), step({ name: "checkout" })],
      KEY,
    );

    expect(resolved.map((entry) => entry.name)).toEqual(["login", "search", "checkout"]);
  });

  it("resolves an empty flow to an empty array", () => {
    expect(resolveFlowSteps([], KEY)).toEqual([]);
  });
});
