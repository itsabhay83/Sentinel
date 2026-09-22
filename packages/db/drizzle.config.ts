import { getServerEnv } from "@sentinel/shared/env";
import { defineConfig } from "drizzle-kit";

const env = getServerEnv();

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: env.DATABASE_URL },
  strict: true,
  verbose: true,
});
