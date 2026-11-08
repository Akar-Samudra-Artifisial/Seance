// Task 8.1: the fixture script puts the store in the Frame_01 state (R13.1 to R13.3).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { creditsTotal, plain } from "../irc/index.js";
import { sessionStartText } from "../irc/reducer.route.js";
import { FIGMA_01_MAIN, FIXTURE_MARKER, stepTime } from "./figma-01-main.js";
import { FixtureShell, createFixtureStore } from "./shell.js";

afterEach(cleanup);

describe("Frame_01 fixture store", () => {
  const state = createFixtureStore().getState();
  const { client, ui } = state;
  const channel = client.windows["c:#fix-bug-123"];

  it("has the four windows in switchbar order, the channel active and Status minimised", () => {
    expect(client.order).toEqual(["status", "c:#fix-bug-123", "c:#landing-page", "q:coder"]);
    expect(client.activeKey).toBe("c:#fix-bug-123");
    expect(ui.minimised).toEqual(["status"]);
    expect(client.windows["c:#landing-page"]?.unread).toBe(true);
    expect(client.windows["q:coder"]?.unread).toBe(false);
  });

  it("has the topic, the +mnt modes and the members with their modes", () => {
    expect(channel?.topic).toBe("Fix NPE on login when email is null");
    expect(channel?.modes).toBe("+mnt");
    const members = Object.values(channel?.members ?? {}).map(
      (m) => `${m.op ? "@" : ""}${m.voice ? "+" : ""}${m.nick}`,
    );
    expect(members.sort()).toEqual(["+reviewer", "@+coder", "@bayu", "researcher"]);
  });

  it("marks researcher away and coder back, and shows credits 42.7, lag 0.12 and TLS", () => {
    expect(Object.keys(client.away)).toEqual(["researcher"]);
    expect(client.away["researcher"]).toBe("reading docs");
    expect(creditsTotal(client).toFixed(1)).toBe("42.7");
    expect(ui.lagSeconds).toBe(0.12);
    expect(ui.serverUrl).toBe("wss://seance.local:6697");
    expect(client.phase).toBe("registered");
  });

  it("holds the Frame_01 chat rows in order with times from 23:38 to 23:47", () => {
    const lines = channel?.lines ?? [];
    const texts = lines.map((l) => plain(l.text));
    // The session-start text uses the runtime's time zone; in UTC (the screenshot tests) it is the
    // Frame_01 text `Fri Nov 06 23:38:02 2026`.
    expect(texts[0]).toBe(sessionStartText(stepTime("23:38:02")));
    expect(sessionStartText(stepTime("23:38:02"))).toMatch(/^--- Session start: \w{3} Nov 0[67] \d\d:38:02 2026$/);
    expect(texts).toContain("Now talking in #fix-bug-123");
    expect(texts).toContain("bayu invited coder");
    expect(texts).toContain("bayu invited reviewer");
    expect(texts).toContain("bayu sets mode: +mnt");
    expect(texts.at(-1)).toBe("coder touched 6 files outside topic scope");
    // Frame_01 node 1:1368, and the prefix at the time of each line (1:1360 `<+coder>`, 1:1376 `<@coder>`).
    expect(texts).toContain("is back (gone 00:01:48)");
    const coderMessages = lines.filter((l) => l.kind === "message" && l.from === "coder").map((l) => l.nickPrefix);
    expect(coderMessages).toEqual(["+", "+", "@", "@"]);
    expect(lines.find((l) => l.kind === "message" && l.from === "reviewer")?.nickPrefix).toBe("");
    expect(lines.filter((l) => l.kind === "tool")).toHaveLength(3);
    // No row without visible text (R9.2).
    expect(texts.every((t) => t.trim() !== "")).toBe(true);
    const first = lines[0]?.at ?? 0;
    const last = lines.at(-1)?.at ?? 0;
    expect(first).toBe(stepTime("23:38:02"));
    expect(last).toBe(stepTime("23:47:10"));
  });

  it("sends nothing to the network: the script is pure data", () => {
    expect(FIGMA_01_MAIN.serverUrl.startsWith("wss://")).toBe(true);
    expect(FIGMA_01_MAIN.steps.every((s) => !s.line.includes("\r") && !s.line.includes("\n"))).toBe(true);
  });
});

describe("FixtureShell", () => {
  it("renders the real Shell with the channel window and sets the marker", () => {
    render(<FixtureShell />);
    expect(screen.getByRole("region", { name: "#fix-bug-123 window" })).toBeTruthy();
    const minimised = screen.getByRole("region", { name: "Minimised windows" });
    expect(within(minimised).getByTestId("minimised-bar")).toBeTruthy();
    expect(document.documentElement.dataset["fixture"]).toBe(FIXTURE_MARKER);
    // Frame_01 shows the typed, unsent command.
    expect((screen.getByLabelText("Message or command") as HTMLInputElement).value).toBe("/kick coder scope creep");
    // Rendered rows with the Frame_01 wording.
    const log = screen.getByRole("log", { name: "#fix-bug-123 messages" });
    const rows = Array.from(log.querySelectorAll(":scope > div > div")).map((r) => r.textContent?.replace(/^\[\d\d:\d\d\] /, ""));
    expect(rows).toContain("-tool- fs.read src/auth/login.ts · 142 lines · 0.3 cr");
    expect(rows).toContain("<+coder> Plan: guard null email in src/auth/login.ts, add test");
    expect(rows).toContain("<@coder> while I'm here I'll also migrate auth/ to the new session API");
    expect(rows).toContain("* coder is back (gone 00:01:48)");
    expect(rows).toContain("-ChanServ- worktree ready: .seance/wt/fix-bug-123 @ a1b2c3d");
    // Status bar and tray caption (Frame_01 1:1520 and 1:1513).
    expect(screen.getByText("Connected to seance.local:6697 (TLS) as bayu")).toBeTruthy();
    const bar = within(minimised).getByTestId("minimised-bar");
    expect(bar.getAttribute("aria-label")).toBe("Status (minimised)");
    expect(within(bar).getByRole("button", { name: "Restore Status" }).textContent).toBe("Status");
  });
});
