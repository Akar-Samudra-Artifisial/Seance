"use client";
// Browser hooks for the responsive layout (web-client-pixel-match R11). Layout decisions are
// CSS (Tailwind `md:` and `lg:`); these three hooks are the only JavaScript that measures.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { BREAKPOINTS } from "../layout/metrics.js";
import { fitCount } from "../layout/fit.js";

const COMPACT_QUERY = `(max-width: ${BREAKPOINTS.medium - 1}px)`;

function subscribeCompact(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia(COMPACT_QUERY);
  mq.addEventListener("change", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
  };
}

const compactNow = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches;

/** True below 768 px (Compact). False on the server and where `matchMedia` is missing. */
export function useCompact(): boolean {
  return useSyncExternalStore(subscribeCompact, compactNow, () => false);
}

/**
 * Keeps `--app-height` on the document element equal to the visual viewport height, so the
 * shell (and with it the Input_Line) stays above an on-screen keyboard (R11.5). Written through
 * the CSSOM; no style attribute in markup. A no-op where `visualViewport` is missing.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (vv === undefined || vv === null) return;
    const root = document.documentElement;
    const update = (): void => {
      root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--app-height");
    };
  }, []);
}

/**
 * Number of leading items that fit in the element `ref` (see `fitCount`). Re-measures with a
 * ResizeObserver, or on window resize where it is missing (jsdom).
 */
export function useFit(
  ref: RefObject<HTMLElement | null>,
  itemWidths: readonly number[],
  reserve: number,
  overflowWidth: number,
): number {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      setWidth(el.getBoundingClientRect().width);
    };
    measure();
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => {
        ro.disconnect();
      };
    }
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  // Before the first measurement, and where layout is not computed (width 0 in jsdom), show all.
  if (width === undefined || width === 0) return itemWidths.length;
  return fitCount(width, itemWidths, reserve, overflowWidth);
}
