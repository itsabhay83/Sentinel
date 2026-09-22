#!/usr/bin/env node
/**
 * Runs one probe worker per dev region in a single terminal.
 *
 * In production each region is its own deployment in its own datacentre, and
 * REGION_CODE is baked into that deployment's environment. Locally we fake the
 * geography: three child processes, three REGION_CODE values, one Redis. The
 * consensus engine cannot tell the difference — it only ever sees region codes
 * attached to check rows — so multi-region quorum, partial outages and region
 * quarantine all exercise their real code paths on a laptop.
 *
 * Usage:
 *   node scripts/dev-probes.mjs            # bom, fra, iad (the devEnabled set)
 *   node scripts/dev-probes.mjs bom sin syd
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const probeDir = resolve(repoRoot, "apps/probe");

const DEV_REGIONS = ["bom", "fra", "iad"];
const regions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEV_REGIONS;

/** Distinct ANSI colours so interleaved logs stay readable. */
const COLORS = ["\u001b[36m", "\u001b[35m", "\u001b[33m", "\u001b[32m", "\u001b[34m", "\u001b[31m"];
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";

/** Health ports are sequential so `curl localhost:4101/health` finds probe #1. */
const HEALTH_PORT_BASE = 4100;

const children = [];
let shuttingDown = false;

function prefixStream(stream, label, color) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      process.stdout.write(`${color}${label}${RESET} ${line}\n`);
    }
  });
}

for (const [index, region] of regions.entries()) {
  const color = COLORS[index % COLORS.length];
  const label = `[${region}]`.padEnd(7);

  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: probeDir,
    env: {
      ...process.env,
      REGION_CODE: region,
      PROBE_HEALTH_PORT: String(HEALTH_PORT_BASE + index + 1),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  prefixStream(child.stdout, label, color);
  prefixStream(child.stderr, label, color);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${color}${label}${RESET} exited (code=${code} signal=${signal})\n`);
    // One probe dying should take the group down rather than silently degrade
    // the fleet to fewer regions than the operator asked for.
    shutdown(code ?? 1);
  });

  children.push(child);
  process.stdout.write(
    `${color}${label}${RESET} ${DIM}starting probe · health http://localhost:${HEALTH_PORT_BASE + index + 1}/health${RESET}\n`,
  );
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${DIM}stopping ${children.length} probe(s)...${RESET}\n`);
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  // Probes drain their in-flight checks before exiting; give them a window,
  // then insist.
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 5_000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
