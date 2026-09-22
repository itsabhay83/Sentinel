import { describe, expect, it } from "vitest";
import {
  DEV_REGIONS,
  REGIONS,
  REGION_CODES,
  RESULTS_QUEUE,
  checkQueueName,
  getRegion,
  isRegionCode,
  type RegionCode,
} from "./regions";

describe("REGION_CODES", () => {
  it("lists each code exactly once", () => {
    expect(new Set(REGION_CODES).size).toBe(REGION_CODES.length);
  });

  it.each(REGION_CODES)("%s is a lowercase three-letter airport code", (code) => {
    expect(code).toMatch(/^[a-z]{3}$/);
    expect(code).toBe(code.toLowerCase());
  });
});

describe("REGIONS", () => {
  it("describes exactly the declared codes, in the same order", () => {
    expect(REGIONS.map((region) => region.code)).toEqual([...REGION_CODES]);
  });

  it.each(REGIONS)("$code carries a city, a country and a plottable coordinate", (region) => {
    expect(region.city.length).toBeGreaterThan(0);
    expect(region.country.length).toBeGreaterThan(0);
    expect(region.lat).toBeGreaterThanOrEqual(-90);
    expect(region.lat).toBeLessThanOrEqual(90);
    expect(region.lng).toBeGreaterThanOrEqual(-180);
    expect(region.lng).toBeLessThanOrEqual(180);
  });

  it("gives no two regions the same coordinate", () => {
    const points = new Set(REGIONS.map((region) => `${region.lat},${region.lng}`));
    expect(points.size).toBe(REGIONS.length);
  });

  it("spans both hemispheres, which is what makes the quorum meaningful", () => {
    expect(REGIONS.some((region) => region.lat > 0)).toBe(true);
    expect(REGIONS.some((region) => region.lat < 0)).toBe(true);
  });
});

describe("DEV_REGIONS", () => {
  it("is the three regions `pnpm dev:probes` starts by default", () => {
    expect([...DEV_REGIONS]).toEqual(["bom", "fra", "iad"]);
  });

  it("contains a region if and only if the table marks it dev-enabled", () => {
    const dev = new Set<string>(DEV_REGIONS);
    for (const region of REGIONS) expect(dev.has(region.code)).toBe(region.devEnabled);
  });

  it("is a non-empty proper subset, so local dev still forms a quorum without paying for eight", () => {
    expect(DEV_REGIONS.length).toBeGreaterThanOrEqual(2);
    expect(DEV_REGIONS.length).toBeLessThan(REGION_CODES.length);
  });

  it.each(DEV_REGIONS)("%s is a real region code", (code) => {
    expect(isRegionCode(code)).toBe(true);
  });
});

describe("isRegionCode", () => {
  it.each(REGION_CODES)("accepts %s", (code) => {
    expect(isRegionCode(code)).toBe(true);
  });

  it.each(["", "mars", "BOM", "bom ", "fr", "frax", "__proto__", "toString"])(
    "rejects %j",
    (value) => {
      expect(isRegionCode(value)).toBe(false);
    },
  );
});

describe("getRegion", () => {
  it.each(REGION_CODES)("returns the table row for %s", (code) => {
    const region = getRegion(code);
    expect(region.code).toBe(code);
    expect(REGIONS).toContain(region);
  });

  it("throws rather than inventing a region for an unknown code", () => {
    // The guard is unreachable through the type system, which is exactly why it
    // needs a test: a row read back from the database is a plain string.
    const unknown = "mars" as RegionCode;
    expect(() => getRegion(unknown)).toThrow(/Unknown region code: mars/);
  });
});

describe("checkQueueName", () => {
  it.each(REGION_CODES)("names %s's inbound queue after the region", (code) => {
    expect(checkQueueName(code)).toBe(`checks-${code}`);
  });

  it("never emits a colon, which BullMQ rejects at queue construction", () => {
    for (const code of REGION_CODES) expect(checkQueueName(code)).not.toContain(":");
  });

  it("gives every region a distinct queue so a probe reads only its own work", () => {
    expect(new Set(REGION_CODES.map(checkQueueName)).size).toBe(REGION_CODES.length);
  });

  it("never collides with the results fan-in queue", () => {
    expect(REGION_CODES.map(checkQueueName)).not.toContain(RESULTS_QUEUE);
  });
});

describe("RESULTS_QUEUE", () => {
  it("is a single colon-free name", () => {
    expect(RESULTS_QUEUE).toBe("results");
    expect(RESULTS_QUEUE).not.toContain(":");
  });
});
