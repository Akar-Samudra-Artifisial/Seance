import { expect, test } from "@playwright/test";
import { webOrigin, wsUrl } from "./harness/env.js";

// The reply text of the Fake_Agent (FAKE_REPLY in harness/stack.ts, without its colour codes).
const REPLY_TEXT = "The veil is thin tonight.";

test("op1 invites coder, voices it, gets a reply, then exorcises it", async ({ page }) => {
  await page.goto(`${webOrigin()}/`);

  // Connect from the allowed web origin; success shows the Ircd accepts that origin.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Server URL")).toHaveValue(wsUrl());
  await dialog.getByLabel("Nick").fill("op1");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();

  const input = page.getByLabel("Message or command");
  const send = async (text: string): Promise<void> => {
    await input.fill(text);
    await input.press("Enter");
  };

  await send("/join #flow");
  const members = page.getByRole("list", { name: /^Members of #flow/ });
  await expect(members.getByText("@op1")).toBeVisible();

  await send("/invite coder #flow");
  await expect(members.getByText("coder")).toBeVisible();

  // The Runner joins the agent first and opens its ACP session afterwards; a channel message sent
  // before the session exists is ignored. The session is ready once /whois lists credits for #flow.
  await expect(async () => {
    await send("/whois coder");
    await expect(page.getByRole("group", { name: "WHOIS coder" }).last()).toContainText("credits: #flow", {
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });

  await send("/mode #flow +v coder");
  await expect(members.getByText("+coder")).toBeVisible();

  await send("coder: tell me something");

  const log = page.getByRole("log");
  const reply = log.locator("div").filter({ hasText: REPLY_TEXT }).filter({ hasText: "<coder>" });
  // The agent's turn (prompt, streamed chunk, line flush) runs on the real clock.
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(reply.locator("span.text-nick-coder", { hasText: /^coder$/ })).toBeVisible();

  await send("/kick coder begone");

  const exorcised = log
    .locator("div")
    .filter({ hasText: "*** coder has been exorcised by op1 (begone)" })
    .filter({ hasText: "[exorcised]" });
  await expect(exorcised).toBeVisible();
  await expect(exorcised).toHaveClass(/bg-ghost-orange/);
  await expect(members.getByText(/^[@+]?coder$/)).toHaveCount(0);
});
