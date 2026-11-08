"use client";

import { useLayoutEffect } from "react";
import type { ReactNode } from "react";
import { useClientStore } from "../store/react.js";

/**
 * Mirrors `ui.theme` onto `<html data-theme>`, where the Classic token overrides in
 * `app/globals.css` apply. It writes an attribute only, so no inline style or script is involved
 * and the CSP is unchanged.
 *
 * The store starts as Ghost, like the server render, so hydration always matches. The stored theme
 * name is applied here, in a layout effect: after hydration, before the first paint, so there is no
 * hydration mismatch and no visible flash of the wrong theme (review finding 7).
 */
export function ThemeSync(): ReactNode {
  const theme = useClientStore((s) => s.ui.theme);
  const loadStoredTheme = useClientStore((s) => s.loadStoredTheme);
  useLayoutEffect(() => {
    loadStoredTheme();
  }, [loadStoredTheme]);
  useLayoutEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);
  return null;
}
