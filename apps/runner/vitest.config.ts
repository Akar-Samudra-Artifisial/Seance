import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    // Real git and child processes are slow when runner and ircd tests run in parallel under turbo.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
