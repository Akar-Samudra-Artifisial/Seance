// runner-services Requirement 7.4 / 9.1, 9.5: the pure notice formatters, without IRC.
import { describe, expect, it } from "vitest";
import {
  CREDITS_WORD,
  NOTICE_MAX_BYTES,
  agentsOnline,
  filesReverted,
  sessionEnded,
  worktreeNoticeDir,
  worktreeReady,
} from "../src/services/notices.js";

/** The trademarked client name `product.md` forbids, built from two fragments (Req 9.5). */
const FORBIDDEN = `${"m"}${"IRC"}`.toLowerCase();

describe("notice shapes (mockup frames 01, 02, 03)", () => {
  it("worktree ready: two-segment dir and a short sha", () => {
    const dir = worktreeNoticeDir("/srv/seance/workspaces/", "#Fix-Bug-123");
    expect(dir).toBe("workspaces/fix-bug-123");
    expect(worktreeReady(dir, "a1b2c3d")).toBe("worktree ready: workspaces/fix-bug-123 @ a1b2c3d");
  });

  it("never shows an absolute path or a home directory", () => {
    const dir = worktreeNoticeDir("/Users/someone/private/ws", "#x");
    expect(dir.startsWith("/")).toBe(false);
    expect(dir).toBe("ws/x");
    expect(dir).not.toContain("someone");
  });

  it("session end: cancelled versus closed", () => {
    expect(sessionEnded({ cancelled: true, sha: "a1b2c3d" })).toBe("session cancelled, worktree reset to a1b2c3d");
    expect(sessionEnded({ cancelled: false, sha: "a1b2c3d" })).toBe("session closed, worktree reset to a1b2c3d");
  });

  it("files reverted: two decimals, singular and plural, the D4 word", () => {
    expect(CREDITS_WORD).toBe("used");
    expect(filesReverted({ files: 6, credits: 4.1 })).toBe("6 files reverted · 4.10 credits used");
    expect(filesReverted({ files: 1, credits: 0 })).toBe("1 file reverted · 0.00 credits used");
    expect(filesReverted({ files: 0, credits: 0.5 })).toBe("0 files reverted · 0.50 credits used");
    expect(filesReverted({ files: 0, credits: 0 })).toBeUndefined();
    expect(filesReverted({ files: 0, credits: 0.004 })).toBeUndefined(); // rounds to 0.00, like WHOIS
  });

  it("agents online: the mockup form for one status, groups in order of first appearance", () => {
    expect(
      agentsOnline([
        { nick: "coder", status: "idle" },
        { nick: "reviewer", status: "idle" },
        { nick: "researcher", status: "idle" },
      ]),
    ).toBe("agents online: coder, reviewer, researcher (idle)");
    expect(
      agentsOnline([
        { nick: "coder", status: "prompting" },
        { nick: "reviewer", status: "idle" },
        { nick: "researcher", status: "prompting" },
      ]),
    ).toBe("agents online: coder, researcher (prompting); reviewer (idle)");
  });

  it("strips control characters from untrusted parts", () => {
    expect(worktreeReady("ws/\x03ab\x07c\r\n", "a1b2c3d")).toBe("worktree ready: ws/abc @ a1b2c3d");
    expect(agentsOnline([{ nick: "co\x02der", status: "idle" }])).toBe("agents online: coder (idle)");
  });

  it("cuts at a code point boundary within NOTICE_MAX_BYTES", () => {
    const text = worktreeReady(`ws/${"é".repeat(400)}`, "a1b2c3d");
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
    expect(text.endsWith("\uFFFD")).toBe(false);
  });

  it("never contains the forbidden trademark term and never says restored (Req 7.2, 9.5)", () => {
    const all = [
      worktreeReady("ws/x", "a1b2c3d"),
      sessionEnded({ cancelled: true, sha: "a1b2c3d" }),
      sessionEnded({ cancelled: false, sha: "a1b2c3d" }),
      filesReverted({ files: 2, credits: 1 }) ?? "",
      agentsOnline([{ nick: "coder", status: "away" }]),
    ];
    for (const t of all) {
      expect(t.toLowerCase()).not.toContain(FORBIDDEN);
      expect(t).not.toMatch(/restored/i);
    }
  });
});
