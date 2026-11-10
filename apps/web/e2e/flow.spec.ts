import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { webOrigin, wsUrl } from "./harness/env.js";

// The reply text of the Fake_Agent (FAKE_REPLY in harness/stack.ts, without its colour codes).
const REPLY_TEXT = "The veil is thin tonight.";

/** Connects through the Connect dialog and returns a helper that submits a line to the Input_Line. */
async function connectAs(page: Page, nick: string): Promise<(text: string) => Promise<void>> {
  await page.goto(`${webOrigin()}/`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Nick").fill(nick);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();
  const input = page.getByLabel("Message or command");
  return async (text: string): Promise<void> => {
    await input.fill(text);
    await input.press("Enter");
  };
}

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
    await expect(page.getByRole("log").getByText("credits: #flow").last()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  await send("/mode #flow +v coder");
  await expect(members.getByText("+coder")).toBeVisible();

  await send("coder: tell me something");

  const log = page.getByRole("log");
  const reply = log.locator("div").filter({ hasText: REPLY_TEXT }).filter({ hasText: "<+coder>" }).last();
  // The agent's turn (prompt, streamed chunk, line flush) runs on the real clock.
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(reply.locator("span.text-nick-coder", { hasText: /^\+coder$/ })).toBeVisible();

  await send("/kick coder begone");

  // The exorcism line (R11): struck agent nick, bold `exorcised`, kicker, reason in brackets, ghost glyph.
  const exorcised = log.locator("div").filter({ hasText: "*** coder has been exorcised by op1 (begone)" }).last();
  await expect(exorcised).toBeVisible();
  await expect(exorcised).toHaveClass(/border-ghost-purple/);
  await expect(exorcised.getByRole("img", { name: "exorcised" })).toBeVisible();
  // The exorcised agent leaves the member count and stays as a struck-through ghost row (R11.6).
  await expect(members.getByText(/^[@+]coder$/)).toHaveCount(0);
  await expect(members.locator("li.line-through", { hasText: /^coder$/ })).toHaveCount(1);
  await expect(members).toHaveAccessibleName(/\(1 user\)/);
});

test("window titles, menus, minimise/restore and status bar", async ({ page }) => {
  const send = await connectAs(page, "chrome1");
  const host = new URL(wsUrl()).host;

  // Status bar text after registration (R6.1).
  await expect(page.getByRole("status").filter({ hasText: `Connected to ${host} as chrome1` })).toBeVisible();

  // Status window title in the Title_Bar and the MDI child (R1, R4.2).
  const titleBar = page.getByTestId("title-bar");
  await expect(titleBar).toContainText("Séance — [Status: chrome1");
  await expect(titleBar).toContainText(`on ${host}]`);
  // pixel-match R2.1: the maximised child has no header any more; the region label names it.
  await expect(page.getByRole("region", { name: "Status window" })).toBeVisible();
  await expect(page).toHaveTitle(/^Séance — \[Status: chrome1/);

  // The six menus (Favorites and Tools › Options… were removed: nothing was behind them).
  const menubar = page.getByRole("menubar", { name: "Main menu" });
  await expect(menubar.getByRole("menuitem")).toHaveText(["File", "View", "Tools", "Commands", "Window", "Help"]);
  await menubar.getByRole("menuitem", { name: "Tools" }).click();
  await expect(page.getByRole("menu", { name: "Tools" }).getByRole("menuitem")).toHaveText(["Whois"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Options" })).toHaveCount(0);

  // Maximise toggles browser full screen; the label follows the real state.
  const fullScreen = page.getByRole("button", { name: "Full screen" });
  await expect(fullScreen).toBeVisible();
  await fullScreen.click();
  await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect(page.getByRole("button", { name: "Full screen" })).toBeVisible();

  // Channel window title in the Title_Bar; the child buttons sit in the menu bar (pixel-match R2.2).
  await send("/join #chrome");
  await expect(titleBar).toContainText("Séance — [#chrome");
  await expect(page.getByRole("region", { name: "#chrome window" })).toBeVisible();

  // Minimise puts the window into the Minimised_Tray; restore takes it out (R4.3, R4.4).
  await page.getByRole("button", { name: "Minimise active window" }).click();
  const bar = page.getByTestId("minimised-bar");
  await expect(bar).toHaveCount(1);
  await expect(bar).toContainText("#chrome");
  await bar.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole("region", { name: "#chrome window" })).toBeVisible();

  // Audit 10.15: Tab and Shift+Tab leave the input line when there is nothing to complete.
  const input = page.getByLabel("Message or command");
  await input.focus();
  await input.pressSequentially("zzz");
  await page.keyboard.press("Tab");
  await expect(input).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).not.toBeFocused();
  await input.fill("");
});

test("Credits_Counter follows a WHOIS of the fake agent", async ({ page }) => {
  const send = await connectAs(page, "op2");
  await send("/join #credits");
  const members = page.getByRole("list", { name: /^Members of #credits/ });
  await expect(members.getByText("@op2")).toBeVisible();
  // Task 10.23: in a channel window the counter shows that channel's cost.
  const counter = page.getByRole("status", { name: "Credits used in this channel" });
  // Two decimals since 2026-11-10 (one decimal showed 0.0 for a 0.01-credit session).
  await expect(counter).toHaveText(/^credits: \d+\.\d{2}$/);

  await send("/invite coder #credits");
  await expect(members.getByText("coder")).toBeVisible();

  // The credits line from the Runner appears once the agent's session is open.
  const log = page.getByRole("log");
  const creditsLine = log.getByText(/credits: #credits [\d.]+ \/ total [\d.]+/).last();
  await expect(async () => {
    await send("/whois coder");
    await expect(creditsLine).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  const used = /credits: #credits ([\d.]+) \//.exec(await creditsLine.innerText())?.[1];
  expect(used, "channel amount in the credits line").toBeDefined();
  await expect(counter).toHaveText(`credits: ${Number(used).toFixed(2)}`);
});

// web-client-extras R8.19: the counter refreshes itself after an agent's reply (a silent WHOIS 2 s
// later), and that WHOIS prints nothing. Each Fake_Agent turn meters FAKE_TURN_CREDITS (0.01).
test("Credits_Counter updates after an agent reply without /whois, and shows no WHOIS block", async ({ page }) => {
  const send = await connectAs(page, "op4");
  await send("/join #silent");
  const members = page.getByRole("list", { name: /^Members of #silent/ });
  await expect(members.getByText("@op4")).toBeVisible();
  const counter = page.getByRole("status", { name: "Credits used in this channel" });
  await expect(counter).toHaveText("credits: 0.00");

  await send("/invite coder #silent");
  await expect(members.getByText("coder")).toBeVisible();
  await send("/mode #silent +v coder");
  await expect(members.getByText("+coder")).toBeVisible();
  // Sent while the session may still be starting: the runner queues it (agent-runner Req 3.21).
  await send("coder: tell me something");

  const log = page.getByRole("log");
  await expect(log.locator("div").filter({ hasText: REPLY_TEXT }).filter({ hasText: "<+coder>" }).last()).toBeVisible({
    timeout: 30_000,
  });
  // Task 10.23: one turn in #silent costs FAKE_TURN_CREDITS, whatever coder spent in other channels.
  await expect(counter).toHaveText("credits: 0.01", { timeout: 15_000 });
  // The silent WHOIS added no block and no WHOIS line to any window.
  await expect(log.getByText(/End of \/WHOIS/)).toHaveCount(0);
  await expect(log.getByText(/credits: #silent/)).toHaveCount(0);
  await page.getByRole("button", { name: "Status window" }).click();
  await expect(page.getByRole("log").getByText(/End of \/WHOIS|credits: #silent/)).toHaveCount(0);
  // Outside a channel the counter shows the session sum; this page only saw #silent's amount.
  await expect(page.getByRole("status", { name: "Credits used this session" })).toHaveText("credits: 0.01");

  // Release the agent: the runner allows two agent channels (SEANCE_MAX_AGENT_CHANNELS).
  await page.getByRole("navigation", { name: "Windows" }).getByRole("button", { name: /#silent/ }).click();
  await send("/kick coder done");
  await expect(log.locator("div").filter({ hasText: "*** coder has been exorcised by op4" }).last()).toBeVisible();
});

test("a kick without a reason shows the exorcism line without brackets", async ({ page }) => {
  const send = await connectAs(page, "op3");
  await send("/join #bare");
  const members = page.getByRole("list", { name: /^Members of #bare/ });
  await expect(members.getByText("@op3")).toBeVisible();
  await send("/invite coder #bare");
  await expect(members.getByText("coder")).toBeVisible();

  await send("/kick coder");
  const exorcised = page.getByRole("log").locator("div").filter({ hasText: "*** coder has been exorcised by op3" }).last();
  await expect(exorcised).toBeVisible();
  // The Ircd defaults the reason to the kicker's nick; the client hides it (R11.2).
  await expect(exorcised).not.toContainText("(");
  await expect(exorcised.getByRole("img", { name: "exorcised" })).toBeVisible();
  await expect(members.getByText(/^[@+]coder$/)).toHaveCount(0);
  await expect(members.locator("li.line-through", { hasText: /^coder$/ })).toHaveCount(1);
  await expect(members).toHaveAccessibleName(/\(1 user\)/);
});
