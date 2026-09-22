import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The migrate/seed CLIs live in @sentinel/db but have no build of their own.
    // Emitting them here keeps every compiled artefact in one image stage and
    // lets the runtime image drop tsx entirely.
    migrate: "../../packages/db/src/cli/migrate.ts",
    seed: "../../packages/db/src/cli/seed.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  // Workspace packages ship raw TypeScript, so they must be inlined. Everything
  // published to npm stays external and is resolved from node_modules at
  // runtime — bullmq loads .lua scripts and pino loads transports from disk,
  // and both break when bundled.
  noExternal: [/^@sentinel\//],
});
