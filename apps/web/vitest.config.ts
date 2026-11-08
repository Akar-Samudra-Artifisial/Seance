import { defineConfig } from "vitest/config";

const exclude = ["e2e/**", "node_modules/**", ".next/**", ".next-e2e/**"];

export default defineConfig({
  test: {
    // Core and store tests run in plain Node; component tests (*.test.tsx) run in jsdom.
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "app/**/*.test.ts", "*.test.ts", "scripts/**/*.test.mjs"],
          exclude,
        },
      },
      {
        // tsconfig uses "jsx": "preserve" for Next; tests need the automatic runtime.
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", "app/**/*.test.tsx"],
          exclude,
        },
      },
    ],
  },
});
