import { describe, expect, it } from "vitest";
import { tickDuration, timePhase } from "./metrics";

async function observationsFor(phase: string): Promise<number> {
  const metric = await tickDuration.get();
  const count = metric.values.find(
    (value) =>
      value.metricName === "sentinel_tick_duration_seconds_count" && value.labels["phase"] === phase,
  );
  return count?.value ?? 0;
}

describe("timePhase", () => {
  it("returns whatever the phase produced", async () => {
    await expect(timePhase("dispatch", () => Promise.resolve(17))).resolves.toBe(17);
  });

  it("records one observation per call against the phase label", async () => {
    const before = await observationsFor("evaluate");

    await timePhase("evaluate", () => Promise.resolve(null));
    await timePhase("evaluate", () => Promise.resolve(null));

    await expect(observationsFor("evaluate")).resolves.toBe(before + 2);
  });

  it("still records the duration when the phase throws, and rethrows untouched", async () => {
    // A tick that blows up is precisely the one whose duration matters; losing
    // the observation would hide the phase that caused the outage.
    const boom = new Error("postgres went away");
    const before = await observationsFor("housekeeping");

    await expect(timePhase("housekeeping", () => Promise.reject(boom))).rejects.toBe(boom);

    await expect(observationsFor("housekeeping")).resolves.toBe(before + 1);
  });

  it("keeps each phase in its own series", async () => {
    await timePhase("alerting", () => Promise.resolve(null));

    await expect(observationsFor("alerting")).resolves.toBe(1);
    await expect(observationsFor("a-phase-never-timed")).resolves.toBe(0);
  });
});
