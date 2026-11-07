import { expect, test } from "@playwright/test";
import { webOrigin } from "./harness/env.js";

test("loads the page and shows the Connect dialog", async ({ page }) => {
  await page.goto(`${webOrigin()}/`);
  await expect(page.getByRole("dialog")).toBeVisible();
});
