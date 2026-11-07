import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Property tests and integration tests slow down when packages run in parallel under turbo.
    testTimeout: 20_000,
  },
});
