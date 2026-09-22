/**
 * Probe regions. Each code maps 1:1 to a Fly.io region so a probe deploys with
 * `fly scale count 1 --region <code>`. lat/lng feeds the dashboard map.
 *
 * Development runs the three DEV_REGIONS to keep cost at zero, but no code may
 * branch on a specific region code — everything is region-agnostic and driven
 * by the `regions` table.
 */

export const REGION_CODES = ["bom", "sin", "fra", "lhr", "iad", "sjc", "gru", "syd"] as const;

export type RegionCode = (typeof REGION_CODES)[number];

export interface RegionSeed {
  readonly code: RegionCode;
  readonly city: string;
  readonly country: string;
  readonly lat: number;
  readonly lng: number;
  /** Enabled by default in local development. */
  readonly devEnabled: boolean;
}

export const REGIONS: readonly RegionSeed[] = [
  { code: "bom", city: "Mumbai", country: "India", lat: 19.076, lng: 72.8777, devEnabled: true },
  { code: "sin", city: "Singapore", country: "Singapore", lat: 1.3521, lng: 103.8198, devEnabled: false },
  { code: "fra", city: "Frankfurt", country: "Germany", lat: 50.1109, lng: 8.6821, devEnabled: true },
  { code: "lhr", city: "London", country: "United Kingdom", lat: 51.5072, lng: -0.1276, devEnabled: false },
  { code: "iad", city: "Virginia", country: "United States", lat: 38.9445, lng: -77.4558, devEnabled: true },
  { code: "sjc", city: "California", country: "United States", lat: 37.3382, lng: -121.8863, devEnabled: false },
  { code: "gru", city: "São Paulo", country: "Brazil", lat: -23.5558, lng: -46.6396, devEnabled: false },
  { code: "syd", city: "Sydney", country: "Australia", lat: -33.8688, lng: 151.2093, devEnabled: false },
];

/** Regions started by `pnpm dev:probes`. */
export const DEV_REGIONS: readonly RegionCode[] = REGIONS.filter((r) => r.devEnabled).map(
  (r) => r.code,
);

const REGION_BY_CODE = new Map<string, RegionSeed>(REGIONS.map((r) => [r.code, r]));

export function isRegionCode(value: string): value is RegionCode {
  return REGION_BY_CODE.has(value);
}

export function getRegion(code: RegionCode): RegionSeed {
  const region = REGION_BY_CODE.get(code);
  if (!region) throw new Error(`Unknown region code: ${code}`);
  return region;
}

/**
 * BullMQ queue name for a region's inbound check jobs.
 *
 * The separator is a hyphen, not a colon: BullMQ builds its own Redis keys as
 * `bull:<queue>:<id>` and throws `Queue name cannot contain :` at construction
 * if the name would make those keys ambiguous. A colon here crashes every probe
 * on boot.
 */
export function checkQueueName(region: string): string {
  return `checks-${region}`;
}

/** Single fan-in queue where every probe publishes its results. */
export const RESULTS_QUEUE = "results";
