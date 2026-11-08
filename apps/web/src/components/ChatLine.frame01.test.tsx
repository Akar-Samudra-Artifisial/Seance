// Frame_01 text rules for chat rows (web-client-pixel-match follow-up): tool rows, notice colours and
// the nick prefix at the time of the line.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Line, Member } from "../irc/index.js";
import { ChatLine } from "./ChatLine.js";

afterEach(cleanup);

const base: Line = { id: 1, at: 0, kind: "message", text: "", mention: false, own: false };

function row(line: Line, members?: Readonly<Record<string, Member>>): HTMLElement {
  const { container } = render(<ChatLine line={line} offsetMinutes={0} members={members} />);
  return container.firstElementChild as HTMLElement;
}

describe("tool rows (Frame_01 1:1365 to 1:1367)", () => {
  it("read `-tool- <text>` in upright grey, without `[tool]` or the `using tool:` lead-in", () => {
    const r = row({ ...base, kind: "tool", from: "coder", text: "using tool: fs.read src/auth/login.ts · 142 lines" });
    expect(r.textContent).toBe("[00:00] -tool- fs.read src/auth/login.ts · 142 lines");
    expect(r.className).toContain("text-tool-grey");
    expect(r.className).not.toContain("italic");
    expect(r.textContent).not.toContain("[tool]");
  });

  it("keep other tool texts (for example `ops:`) whole", () => {
    const r = row({ ...base, kind: "tool", from: "coder", text: "ops: shell allowed" });
    expect(r.textContent).toBe("[00:00] -tool- ops: shell allowed");
  });

  it("read denied tool rows as `[denied] -tool- <text>`, struck through, without the lead-in", () => {
    const r = row({ ...base, kind: "tool-denied", from: "coder", text: "ops: shell denied" });
    expect(r.textContent).toBe("[00:00] [denied] -tool- ops: shell denied");
    expect(r.className).toContain("line-through");
    const lead = row({ ...base, kind: "tool-denied", from: "coder", text: "using tool: shell rm -rf · denied" });
    expect(lead.textContent).toBe("[00:00] [denied] -tool- shell rm -rf · denied");
  });
});

describe("notices (Frame_01 1:1354, 1:1369)", () => {
  it("colour only `-nick-` orange; the text uses the normal foreground", () => {
    const r = row({ ...base, kind: "notice", from: "ChanServ", text: "worktree ready: wt @ a1b2c3d" });
    expect(r.textContent).toBe("[00:00] -ChanServ- worktree ready: wt @ a1b2c3d");
    expect(r.className).toContain("text-ghost-text");
    const orange = r.querySelectorAll(".text-ghost-orange");
    expect(orange).toHaveLength(1);
    expect(orange[0]?.textContent).toBe("-ChanServ-");
  });

  it("use the accent orange for an agent's notice name too, not its nick colour", () => {
    const r = row({ ...base, kind: "notice", from: "coder", text: "diff ready" });
    expect(r.querySelector(".text-ghost-orange")?.textContent).toBe("-coder-");
    expect(r.querySelector(".text-nick-coder")).toBeNull();
  });
});

describe("nick prefix at the time of the line (Frame_01 1:1360)", () => {
  const nowOp: Readonly<Record<string, Member>> = { coder: { nick: "coder", op: true, voice: true } };

  it("uses the prefix stored on the line, not the current mode", () => {
    const r = row({ ...base, from: "coder", text: "Plan: guard null email", nickPrefix: "+" }, nowOp);
    expect(r.textContent).toBe("[00:00] <+coder> Plan: guard null email");
  });

  it("keeps an empty stored prefix even when the nick is op now", () => {
    const r = row({ ...base, from: "coder", text: "hi", nickPrefix: "" }, nowOp);
    expect(r.textContent).toBe("[00:00] <coder> hi");
  });

  it("falls back to the current members when the line has no stored prefix", () => {
    const r = row({ ...base, from: "coder", text: "hi" }, nowOp);
    expect(r.textContent).toBe("[00:00] <@coder> hi");
  });
});
