import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChatLine } from "./ChatLine.js";
import type { Line } from "../irc/index.js";

afterEach(cleanup);

const base: Line = { id: 1, at: 0, kind: "numeric", text: "", mention: false, own: false };

function renderLine(line: Line): HTMLElement {
  const { container } = render(<ChatLine line={line} offsetMinutes={0} />);
  return container;
}

describe("ChatLine status formats", () => {
  it("renders numerics as [HH:MM] NNN text with a dim code", () => {
    const c = renderLine({ ...base, code: "002", text: "Your host" });
    expect(c.textContent).toBe("[00:00] 002 Your host");
    expect(c.querySelector("span.text-timestamp-dim + span.text-timestamp-dim")).not.toBeNull();
  });

  it("renders the MOTD heading (375) bold", () => {
    const c = renderLine({ ...base, kind: "motd", code: "375", text: "- irc.test MOTD -" });
    expect(c.querySelector("strong")?.textContent).toBe("- irc.test MOTD -");
  });

  it("keeps the leading '- ' of MOTD body lines and does not wrap", () => {
    const c = renderLine({ ...base, kind: "motd", code: "372", text: "-   /\\_/\\" });
    expect(c.textContent).toBe("[00:00] 372 -   /\\_/\\");
    expect(c.firstElementChild?.className).toContain("whitespace-pre ");
    expect(c.firstElementChild?.className).not.toContain("whitespace-pre-wrap");
    expect(c.querySelector("strong")).toBeNull();
  });

  it("renders server notices in the accent orange", () => {
    const c = renderLine({ ...base, kind: "notice", text: "-irc.test- hello" });
    expect(c.textContent).toBe("[00:00] -irc.test- hello");
    expect(c.firstElementChild?.className).toContain("text-ghost-orange");
  });
});
