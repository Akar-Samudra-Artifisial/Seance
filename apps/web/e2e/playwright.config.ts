import { defineConfig } from "@playwright/test";

// Opt-in e2e: `pnpm --filter @seance/web test:e2e`. The stack (Ircd, Runner, Next prod build) is started by
// globalSetup, which also exports E2E_WEB_PORT and E2E_WS_PORT (see harness/env.ts) for the specs.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  globalSetup: "./harness/stack.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  use: { browserName: "chromium" },
});
