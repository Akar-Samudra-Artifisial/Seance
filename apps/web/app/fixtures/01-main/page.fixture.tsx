import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FixtureShell } from "../../../src/fixtures/shell";

// Test-only route (web-client-pixel-match R13.4): this file is a page only when the build runs with
// SEANCE_E2E_FIXTURES=1, which adds the `fixture.tsx` page extension in next.config.ts.

export const metadata: Metadata = {
  title: "Séance fixture: 01 Main",
  robots: { index: false, follow: false },
};

export default function FixtureMainPage(): ReactNode {
  return <FixtureShell />;
}
