import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone with only the modules the server actually reaches,
  // so the production image ships no devDependencies. See Dockerfile stage `web`.
  output: "standalone",
  // The workspace packages ship raw TypeScript (no build step, see DECISIONS.md).
  // Next has to compile them itself rather than expecting prebuilt JS.
  transpilePackages: ["@sentinel/db", "@sentinel/shared", "@sentinel/checker"],
  serverExternalPackages: ["postgres", "ioredis", "bullmq"],
  experimental: {
    serverActions: {
      // Server Actions carry monitor payloads (headers, bodies, flow steps).
      bodySizeLimit: "2mb",
    },
  },
  typescript: { ignoreBuildErrors: false },
};

export default config;
