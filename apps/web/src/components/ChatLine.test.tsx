import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChatLine } from "./ChatLine.js";
import type { Line } from "../irc/index.js";

afterEach(cleanup);

const base: Line = { id: 1, at: 0, kind: "message", text: "", mention: false, own: false };

function renderLine(line: Line): HTMLElement {
  const { container } = render(<ChatLine line={line} offsetMinutes={0} />);
  return container;
}

describe("ChatLine", () => {
  it("renders an exorcism with a reason", () => {
    const c = renderLine({
      ...base,
      kind: "exorcised-kick",
      text: "",
      exorcism: { agent: "Coder", kicker: "\x02op\x02", reason: "\x034bad\x03 code" },
    });
    expect(c.textContent).toBe("[00:00] *** Coder has been exorcised by op (bad code)");
    expect(c.querySelector(".text-irc-4")?.textContent).toBe("bad");
    expect(c.querySelector(".font-bold")?.textContent).toBe("exorcised");
    expect(c.querySelector(".line-through")?.textContent).toBe("Coder");
    expect(c.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("exorcised");
    expect(c.querySelector(".border-ghost-purple")).not.toBeNull();
    expect(c.querySelector("[style]")).toBeNull();
    expect(c.textContent).not.toContain("\x03");
  });

  it("omits parentheses when the reason has no visible character", () => {
    for (const reason of ["", "\x02\x03", "  "]) {
      const c = renderLine({
        ...base,
        kind: "exorcised-kick",
        exorcism: { agent: "coder", kicker: "op", reason },
      });
      expect(c.textContent).toBe("[00:00] *** coder has been exorcised by op");
    }
  });

  it("omits a reason equal to the kicker", () => {
    const c = renderLine({
      ...base,
      kind: "exorcised-kick",
      exorcism: { agent: "coder", kicker: "Op", reason: "op" },
    });
    expect(c.textContent).toBe("[00:00] *** coder has been exorcised by Op");
  });

  it("links http URLs with a safe rel", () => {
    const c = renderLine({ ...base, from: "alice", text: "see http://example.com/x now" });
    const a = c.querySelector("a");
    expect(a?.getAttribute("href")).toBe("http://example.com/x");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps javascript: as plain text", () => {
    const c = renderLine({ ...base, from: "alice", text: "javascript:alert(1)" });
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("javascript:alert(1)");
  });

  it("maps colour codes and nick colours to fixed classes", () => {
    const c = renderLine({ ...base, from: "reviewer", text: "\x0304,12hi" });
    expect(c.querySelector(".text-irc-4.bg-irc-12")?.textContent).toBe("hi");
    expect(c.querySelector(".text-nick-reviewer")?.textContent).toBe("reviewer");
    expect(c.querySelector("[style]")).toBeNull();
    const h = renderLine({ ...base, from: "alice", text: "x" });
    expect(h.querySelector(".text-nick-human")?.textContent).toBe("alice");
  });

  it("renders actions and markers", () => {
    const c = renderLine({ ...base, kind: "action", from: "coder", text: "waves", mention: true });
    expect(c.textContent).toBe("[00:00] [mention] * coder waves");
  });
});
