import type { RouterContext } from "./command-router.js";

/** Current time in milliseconds from the injected clock, defaulting to `Date.now`. */
export const nowMs = (ctx: RouterContext): number => (ctx.now ?? Date.now)();

/** Current time in whole Unix seconds from the injected clock. */
export const nowSeconds = (ctx: RouterContext): number => Math.floor(nowMs(ctx) / 1000);
