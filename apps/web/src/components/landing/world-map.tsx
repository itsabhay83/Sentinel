import { REGIONS } from "@sentinel/shared";

/**
 * The eight probe regions, plotted.
 *
 * No map library and no image: a tile this size needs a silhouette, not a
 * dataset, and pulling in a topojson world would cost more transferred bytes
 * than the rest of the page combined. The coastlines below are deliberately
 * coarse — they are drawn through the same projection as the region pins, so
 * the pins land where the shapes say they should even though the shapes are
 * approximate.
 */

const WIDTH = 1000;
/** Mercator explodes toward the poles; clipping keeps the tile from being mostly ice. */
const LAT_TOP = 76;
const LAT_BOTTOM = -54;

function mercator(lat: number): number {
  const phi = (lat * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

const SCALE = WIDTH / (2 * Math.PI);
const Y_TOP = mercator(LAT_TOP);
const HEIGHT = (Y_TOP - mercator(LAT_BOTTOM)) * SCALE;

function project(lat: number, lng: number): { x: number; y: number } {
  return {
    x: ((lng + 180) / 360) * WIDTH,
    y: (Y_TOP - mercator(lat)) * SCALE,
  };
}

/** Coastlines as `[lng, lat]` rings, closed by the renderer. */
const LANDMASSES: readonly (readonly (readonly [number, number])[])[] = [
  // North America
  [
    [-168, 65], [-164, 60], [-152, 58], [-146, 61], [-135, 57], [-130, 52], [-124, 48], [-124, 40],
    [-118, 34], [-114, 30], [-110, 24], [-105, 20], [-97, 16], [-92, 15], [-87, 13], [-83, 8],
    [-78, 8], [-80, 16], [-88, 21], [-90, 25], [-82, 25], [-80, 32], [-75, 35], [-70, 42],
    [-66, 45], [-60, 47], [-56, 51], [-64, 58], [-78, 63], [-95, 70], [-115, 70], [-130, 70],
    [-156, 71],
  ],
  // Greenland
  [[-45, 60], [-25, 68], [-20, 74], [-30, 76], [-45, 76], [-58, 74], [-55, 66]],
  // South America
  [
    [-81, 0], [-78, -5], [-75, -14], [-70, -18], [-71, -30], [-73, -42], [-75, -50], [-68, -54],
    [-62, -50], [-58, -38], [-52, -32], [-48, -25], [-40, -20], [-35, -8], [-44, -2], [-50, 0],
    [-60, 5], [-70, 11], [-77, 8],
  ],
  // Africa
  [
    [-17, 15], [-16, 22], [-10, 28], [-6, 35], [10, 37], [20, 32], [32, 31], [35, 25], [38, 18],
    [43, 12], [51, 12], [48, 3], [41, -2], [40, -12], [35, -20], [32, -26], [27, -34], [18, -34],
    [13, -20], [9, -2], [5, 5], [-4, 5], [-12, 8],
  ],
  /*
   * Eurasia as one simple, non-self-intersecting ring: Iberia north to
   * Scandinavia, east across the Arctic to Kamchatka, south down the Pacific
   * coast, west through India and Arabia, then back along the Mediterranean.
   * Tracing it in one direction is what keeps the fill from folding over
   * itself and swallowing the Middle East.
   */
  [
    [-9, 43], [-2, 43], [-2, 48], [2, 51], [8, 54], [11, 58], [18, 60], [24, 66], [31, 70],
    [45, 69], [60, 71], [80, 74], [105, 76], [130, 72], [155, 69], [170, 66],
    [160, 60], [143, 54], [135, 45], [127, 38], [122, 31], [110, 21], [105, 10], [100, 6],
    [98, 14], [92, 21], [87, 21], [80, 15], [77, 8],
    [72, 20], [64, 25], [57, 23], [52, 17], [45, 13], [43, 17], [39, 22], [35, 29],
    [36, 36], [28, 38], [23, 38], [19, 40], [16, 41], [12, 38], [10, 44], [4, 43], [-2, 37], [-9, 38],
  ],
  // Australia
  [
    [114, -22], [113, -26], [116, -35], [126, -33], [135, -35], [141, -38], [147, -38], [151, -33],
    [153, -28], [146, -19], [142, -11], [136, -12], [130, -12], [125, -14], [122, -18],
  ],
  // New Zealand, because a Sydney probe with nothing to its east reads as an error
  [[172, -34], [178, -37], [176, -41], [171, -44], [166, -46], [168, -42], [171, -38]],
  // Japan
  [[130, 31], [136, 34], [141, 39], [142, 45], [140, 41], [136, 37], [131, 33]],
  // Madagascar
  [[43, -12], [50, -15], [50, -25], [45, -25], [43, -18]],
  // United Kingdom and Ireland
  [[-6, 50], [-1, 51], [1, 53], [-3, 58], [-6, 57], [-5, 53], [-10, 54], [-10, 51]],
];

function ring(points: readonly (readonly [number, number])[]): string {
  return (
    points
      .map(([lng, lat], index) => {
        const { x, y } = project(lat, lng);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join("") + "Z"
  );
}

/** The arcs converge here — one origin so the fan reads as "eight probes, one target". */
const TARGET = project(37.3382, -121.8863);

/** A quadratic bow, lifted perpendicular to the chord so arcs never lie flat on the map. */
function arc(from: { x: number; y: number }): string {
  const midX = (from.x + TARGET.x) / 2;
  const midY = (from.y + TARGET.y) / 2;
  const lift = Math.hypot(TARGET.x - from.x, TARGET.y - from.y) * 0.18;
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${midX.toFixed(1)} ${(midY - lift).toFixed(1)} ${TARGET.x.toFixed(1)} ${TARGET.y.toFixed(1)}`;
}

export function WorldMap() {
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT.toFixed(0)}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Probe regions: ${REGIONS.map((r) => `${r.city}, ${r.country}`).join("; ")}.`}
    >
      {/* Graticule at 30°/20°, low enough to read as grid rather than as data. */}
      <g stroke="currentColor" className="text-line" strokeWidth="0.6" opacity="0.5">
        {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lng) => {
          const { x } = project(0, lng);
          return <line key={lng} x1={x} y1={0} x2={x} y2={HEIGHT} />;
        })}
        {[60, 40, 20, 0, -20, -40].map((lat) => {
          const { y } = project(lat, 0);
          return <line key={lat} x1={0} y1={y} x2={WIDTH} y2={y} />;
        })}
      </g>

      <g className="text-surface-3" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        {LANDMASSES.map((land, index) => (
          <path key={index} d={ring(land)} />
        ))}
      </g>

      {/* Arcs are pure decoration over a map that is already labelled, and they
          are the one thing here that loops, so they stay behind the pins. */}
      <g className="text-accent" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
        {REGIONS.filter((region) => region.code !== "sjc").map((region, index) => (
          <path
            key={region.code}
            className="sentinel-arc"
            d={arc(project(region.lat, region.lng))}
            pathLength={100}
            style={{ animationDelay: `${index * 500}ms` }}
          />
        ))}
      </g>

      {REGIONS.map((region, index) => {
        const { x, y } = project(region.lat, region.lng);
        // Tooltips flip to the left half of the map so a Sydney or Mumbai pin
        // does not push its label off the viewBox.
        const flip = x > WIDTH * 0.72;
        return (
          <g key={region.code} className="sentinel-pin">
            <circle
              className="sentinel-ping text-accent"
              cx={x}
              cy={y}
              r={5}
              fill="currentColor"
              opacity="0.45"
              style={{ animationDelay: `${index * 375}ms` }}
            />
            <circle cx={x} cy={y} r={3.5} className="text-accent" fill="currentColor" />
            {/* An invisible, generous hit area: a 3.5px dot is not a pointer target. */}
            <circle cx={x} cy={y} r={22} fill="transparent" />
            <g className="sentinel-pin-tip" aria-hidden>
              <rect
                x={flip ? x - 297 : x + 12}
                y={y - 14}
                width={285}
                height={28}
                rx={6}
                className="text-surface-3"
                fill="currentColor"
                stroke="var(--color-line-strong)"
              />
              <text
                x={flip ? x - 285 : x + 24}
                y={y + 5}
                className="fill-ink-2 font-mono"
                fontSize={15}
              >
                {region.code} · {region.city}, {region.country}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
