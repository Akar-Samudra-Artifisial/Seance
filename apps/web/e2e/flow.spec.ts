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
  await expect(members).toHaveAccessibleName(/\(1 users\)/);
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
  await expect(page.getByTestId("mdi-title")).toContainText(`Status: chrome1 on ${host}`);
  await expect(page).toHaveTitle(/^Séance — \[Status: chrome1/);

  // The seven menus; Favorites and Options… are disabled (R2).
  const menubar = page.getByRole("menubar", { name: "Main menu" });
  await expect(menubar.getByRole("menuitem")).toHaveText([
    "File",
    "View",
    "Favorites",
    "Tools",
    "Commands",
    "Window",
    "Help",
  ]);
  await expect(menubar.getByRole("menuitem", { name: "Favorites" })).toHaveAttribute("aria-disabled", "true");
  await menubar.getByRole("menuitem", { name: "Tools" }).click();
  const options = page.getByRole("menu").getByRole("menuitem", { name: "Options…" });
  await expect(options).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Channel window title in the Title_Bar and the MDI child.
  await send("/join #chrome");
  await expect(titleBar).toContainText("Séance — [#chrome");
  const mdiTitle = page.getByTestId("mdi-title");
  await expect(mdiTitle).toContainText("#chrome");

  // Minimise puts the window into the Minimised_Tray; restore takes it out (R4.3, R4.4).
  await mdiTitle.getByRole("button", { name: "Minimise" }).click();
  const bar = page.getByTestId("minimised-bar");
  await expect(bar).toHaveCount(1);
  await expect(bar).toContainText("#chrome");
  await bar.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("mdi-title")).toContainText("#chrome");
});

test("Credits_Counter follows a WHOIS of the fake agent", async ({ page }) => {
  const send = await connectAs(page, "op2");
  await send("/join #credits");
  const members = page.getByRole("list", { name: /^Members of #credits/ });
  await expect(members.getByText("@op2")).toBeVisible();
  const counter = page.getByRole("status", { name: "Credits used by agents" });
  await expect(counter).toHaveText(/^credits: \d+\.\d$/);

  await send("/invite coder #credits");
  await expect(members.getByText("coder")).toBeVisible();

  // The credits line from the Runner appears once the agent's session is open.
  const log = page.getByRole("log");
  const creditsLine = log.getByText(/credits: #credits [\d.]+ \/ total [\d.]+/).last();
  await expect(async () => {
    await send("/whois coder");
    await expect(creditsLine).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  const total = /total ([\d.]+)/.exec(await creditsLine.innerText())?.[1];
  expect(total, "total in the credits line").toBeDefined();
  await expect(counter).toHaveText(`credits: ${Number(total).toFixed(1)}`);
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
  await expect(members).toHaveAccessibleName(/\(1 users\)/);
});
