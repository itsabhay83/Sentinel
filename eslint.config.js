import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Rules that only make sense on a typed program; applied to every TS file. */
const typeAwareRules = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/ban-ts-comment": "error",
  // Drizzle and BullMQ hand back `any`-typed rows in a few places; assigning one
  // into a properly typed local is how the code narrows it, and flagging that
  // would fire on correct code.
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-unsafe-call": "off",
  "@typescript-eslint/no-unsafe-return": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  // Downgraded, not silenced: each has a handful of pre-existing hits in
  // application source that is under concurrent edit. They stay visible in
  // `pnpm lint` output and should be promoted back to "error" once cleared.
  "@typescript-eslint/no-unnecessary-type-assertion": "warn",
  "@typescript-eslint/no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/prefer-promise-reject-errors": "warn",
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/coverage/**",
      "packages/db/drizzle/**",
      ".run/**",
      "**/next-env.d.ts",
      "**/*.tsbuildinfo",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        // projectService resolves each file to its own workspace tsconfig, which
        // is what makes type-aware rules work across all six packages at once.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: typeAwareRules,
  },

  // Backend processes and shared packages log through pino. A bare console.*
  // bypasses structured logging and the log level entirely.
  {
    files: ["apps/scheduler/**/*.ts", "apps/probe/**/*.ts", "packages/**/*.ts"],
    rules: { "no-console": "error" },
  },

  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
    },
    // Without this the App Router lives at apps/web and next's page-link rule
    // looks for ./pages at the monorepo root, warning on every run.
    settings: { next: { rootDir: "apps/web" } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      // Server Components legitimately log to stdout; the container captures it.
      "no-console": "warn",
    },
  },

  // CLI entry points in packages/db print migration progress to a terminal.
  // partitions.ts takes an injectable pino-shaped logger and falls back to
  // console when a caller supplies none; that fallback is the exception, not a
  // stray debug statement.
  {
    files: ["packages/db/src/cli/**/*.ts", "packages/db/src/partitions.ts", "scripts/**/*.{js,mjs,ts}"],
    rules: { "no-console": "off" },
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/testing/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Config files and plain JS tooling are not part of any tsconfig program.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node },
  },
);
