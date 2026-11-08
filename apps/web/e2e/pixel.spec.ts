// Screenshot and layout checks on the Frame_01 fixture (web-client-pixel-match R14). Runs in the five
// pixel projects of playwright.config.ts. Baselines: e2e/__screenshots__/<project>/ (app-generated);
// the Figma comparison uses e2e/figma/01-main-1440x900.png when that manual export exists.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { webOrigin } from "./harness/env.js";

const FIGMA_EXPORT = resolve(dirname(fileURLToPath(import.meta.url)), "figma/01-main-1440x900.png");
const FIXTURE_PATH = "/fixtures/01-main";
const MASK_COLOUR = "#FF00FF";
/**
 * Design Open Point 7: measured 22,083 of 1,296,000 pixels (0.01704) on 2026-11-08 with macOS
 * Chromium and the masks below; limit = measured + 20 %. To re-measure, set 0 and read the ratio
 * from the failure message.
 */
const FIGMA_MAX_DIFF_RATIO = 0.0205;

async function openFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  const res = await page.goto(`${webOrigin()}${FIXTURE_PATH}`);
  expect(res?.status(), "fixture route (build with SEANCE_E2E_FIXTURES=1)").toBe(200);
  await page.waitForSelector("html[data-fixture='SEANCE_FIXTURE_01_MAIN']");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * Regions whose colours are lifted on purpose (Finding 4), masked in the Figma comparison. The
 * timestamp mask also covers the session-start row, whose whole text uses the dim token (and whose
 * wording differs from Frame_01 anyway).
 */
function liftedMasks(page: Page): Locator[] {
  return [
    page.locator("[role=log] .text-timestamp-dim"),
    page.locator("#nick-list + p"),
    page.locator("#nick-list li.text-away-grey"),
    page.getByText(/^lag /),
  ];
}

test.describe("Frame_01 fixture", () => {
  test.beforeEach(async ({ page }) => {
    await openFixture(page);
  });

  test("matches the app baseline (R14.1)", async ({ page }) => {
    await expect(page).toHaveScreenshot("01-main.png", { fullPage: false });
  });

  test("matches the Figma export at 1440x900 (R14.2)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1440", "Figma comparison is for 1440x900 only");
    test.skip(!existsSync(FIGMA_EXPORT), "Figma export missing");
    const masks = liftedMasks(page);
    // Playwright paints masks on the actual screenshot only. The export is the expected image, so the
    // same boxes are painted on a copy of it, placed where toHaveScreenshot looks for this name.
    const boxes = (
      await Promise.all(
        masks.map((m) =>
          m.evaluateAll((els) =>
            els.map((e) => {
              const r = e.getBoundingClientRect();
              return [r.x, r.y, r.width, r.height] as const;
            }),
          ),
        ),
      )
    ).flat();
    const exportUrl = `data:image/png;base64,${readFileSync(FIGMA_EXPORT).toString("base64")}`;
    const maskedExport = await page.evaluate(
      async ({ src, boxes, colour }) => {
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error("Figma export did not decode"));
          img.src = src;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("no 2d context");
        ctx.drawImage(img, 0, 0);
        ctx.fillStyle = colour;
        for (const [x, y, w, h] of boxes) ctx.fillRect(x, y, w, h);
        return canvas.toDataURL("image/png").split(",")[1] ?? "";
      },
      { src: exportUrl, boxes, colour: MASK_COLOUR },
    );
    const target = testInfo.snapshotPath("figma-01-main.png");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(maskedExport, "base64"));
    // Design Open Point 7: measured ratio plus 20 percent.
    await expect(page).toHaveScreenshot("figma-01-main.png", {
      maxDiffPixelRatio: FIGMA_MAX_DIFF_RATIO,
      mask: masks,
      maskColor: MASK_COLOUR,
    });
  });

  test("has no horizontal overflow (R11.1, R14.3)", async ({ page }) => {
    const report = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const scrolls = (el: Element): boolean => getComputedStyle(el).overflowX !== "visible";
      const offenders: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right <= vw + 0.5) continue;
        // Inside an element that clips or scrolls on purpose (switchbar, truncation) and itself fits.
        let clipped = false;
        for (let p = el.parentElement; p !== null; p = p.parentElement) {
          if (scrolls(p) && p.getBoundingClientRect().right <= vw + 0.5) {
            clipped = true;
            break;
          }
        }
        if (clipped) continue;
        const id = el.id === "" ? "" : `#${el.id}`;
        const cls = typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 3).join(".")}` : "";
        offenders.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(r.right)}`);
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: vw,
        offenders: offenders.slice(0, 20),
      };
    });
    expect(report.offenders, "elements beyond the viewport").toEqual([]);
    expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth);
  });

  test("raises no CSP violation (R13.7)", async ({ page }) => {
    const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
    expect(violations).toEqual([]);
  });

  test("places the nine regions at the Frame_01 boxes (R14.5)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1440", "region geometry is pinned at 1440x900");
    const regions: ReadonlyArray<readonly [string, Locator, { x?: number; y: number; w?: number; h: number }]> = [
      ["title bar", page.getByTestId("title-bar"), { x: 3, y: 3, w: 1434, h: 22 }],
      ["menu bar", page.getByRole("menubar").locator(".."), { x: 3, y: 25, w: 1434, h: 20 }],
      ["toolbar", page.getByRole("toolbar").locator(".."), { x: 3, y: 45, w: 1434, h: 32 }],
      ["topic field", page.getByLabel("Channel topic"), { x: 3, y: 79, w: 1434, h: 24 }],
      ["chat pane", page.getByRole("log").locator(".."), { x: 3, y: 105, w: 1250, h: 686 }],
      ["nick list", page.locator("aside:has(#nick-list)"), { x: 1256, y: 105, w: 181, h: 686 }],
      ["input line", page.locator("#input-line"), { x: 3, y: 793, w: 1434, h: 24 }],
      ["tray", page.getByRole("region", { name: "Minimised windows" }), { x: 3, y: 819, w: 1434, h: 28 }],
      ["switchbar", page.getByRole("navigation", { name: "Windows" }).locator(".."), { x: 3, y: 849, w: 1434, h: 26 }],
      ["status bar", page.getByRole("status").filter({ hasText: "Connected to" }), { x: 3, y: 876, w: 1434, h: 21 }],
    ];
    for (const [name, locator, want] of regions) {
      const box = await locator.boundingBox();
      expect(box, name).not.toBeNull();
      if (box === null) continue;
      const got = { x: box.x, y: box.y, w: box.width, h: box.height };
      for (const k of ["x", "y", "w", "h"] as const) {
        const expected = want[k];
        if (expected === undefined) continue;
        expect(Math.abs(got[k] - expected), `${name} ${k}: got ${got[k]}, want ${expected}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("gives every control a 32x32 hit area on touch (R11.6, R14.4)", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("compact"), "touch sizes only");
    const small = await page.evaluate(() => {
      const out: string[] = [];
      const controls = document.querySelectorAll("button, input, a[href], [role=menuitem]");
      for (const el of Array.from(controls)) {
        if (el.closest("[role=log]") !== null) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue; // not rendered (sr-only, hidden)
        const after = getComputedStyle(el, "::after");
        const hitW = Math.max(r.width, after.content === "none" ? 0 : Number.parseFloat(after.width) || 0);
        const hitH = Math.max(r.height, after.content === "none" ? 0 : Number.parseFloat(after.height) || 0);
        if (hitW < 32 || hitH < 32) {
          const label = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName;
          out.push(`${label}: ${Math.round(hitW)}x${Math.round(hitH)}`);
        }
      }
      return out;
    });
    expect(small).toEqual([]);
  });

  test("Compact: the agents button opens and closes the nick overlay (R11.4)", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("compact"), "Compact only");
    await expect(page.locator("#nick-list")).toHaveCount(0);
    const agents = page.getByRole("button", { name: "Agents" });
    await agents.click();
    const overlay = page.getByRole("complementary", { name: "Members of #fix-bug-123" });
    await expect(overlay).toBeVisible();
    await expect(page.locator("#nick-list")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
    await expect(agents).toBeFocused();
  });
});
