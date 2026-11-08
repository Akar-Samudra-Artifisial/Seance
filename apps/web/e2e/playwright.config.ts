import { defineConfig } from "@playwright/test";
import type { PlaywrightTestOptions, PlaywrightWorkerOptions } from "@playwright/test";

type UseOptions = Partial<PlaywrightTestOptions & PlaywrightWorkerOptions>;

// Opt-in e2e: `pnpm --filter @seance/web test:e2e`. The stack (Ircd, Runner, Next prod build) is started by
// globalSetup, which also exports E2E_WEB_PORT and E2E_WS_PORT (see harness/env.ts) for the specs.
//
// Projects: `flows` runs the behaviour specs once; the five pixel projects run pixel.spec.ts against the
// fixture page (web-client-pixel-match R14) at the Frame_01 and responsive sizes.

const PIXEL = /pixel\.spec\.ts$/;

/** Stable rendering for screenshots (design: Screenshot test plan). */
const stable: UseOptions = {
  timezoneId: "UTC",
  locale: "en-US",
  colorScheme: "light",
  contextOptions: { reducedMotion: "reduce" },
  // Headless Chromium hides scrollbars by default; the always-visible chat scrollbar (R7.2) is part
  // of the picture, so keep it.
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
};

const touch = (width: number, height: number): UseOptions => ({
  ...stable,
  viewport: { width, height },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  globalSetup: "./harness/stack.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  use: { browserName: "chromium" },
  // R14.6: baselines per project, no platform suffix (generated on macOS Chromium; see design.md).
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  expect: { toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css" } },
  projects: [
    { name: "flows", testIgnore: PIXEL },
    { name: "desktop-1440", testMatch: PIXEL, use: { ...stable, viewport: { width: 1440, height: 900 } } },
    { name: "desktop-1024", testMatch: PIXEL, use: { ...stable, viewport: { width: 1024, height: 768 } } },
    { name: "medium-768", testMatch: PIXEL, use: { ...stable, viewport: { width: 768, height: 1024 } } },
    { name: "compact-390", testMatch: PIXEL, use: touch(390, 844) },
    { name: "compact-360", testMatch: PIXEL, use: touch(360, 740) },
  ],
});
