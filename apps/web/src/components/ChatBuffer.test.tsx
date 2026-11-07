import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Line } from "../irc/index.js";
import { ChatBuffer } from "./ChatBuffer.js";

afterEach(cleanup);

describe("ChatBuffer", () => {
  it("is a polite live log with an accessible name", () => {
    render(<ChatBuffer label="Messages in #dev" lines={[]} />);
    const log = screen.getByRole("log", { name: "Messages in #dev" });
    expect(log.getAttribute("aria-live")).toBe("polite");
  });

  it("is keyboard focusable so it can be scrolled", () => {
    render(<ChatBuffer label="Messages in #dev" lines={[]} />);
    expect(screen.getByRole("log").getAttribute("tabindex")).toBe("0");
  });

  it("uses the Win95 scrollbar, bottom anchoring and 15/21 rows", () => {
    const line: Line = { id: 1, at: 0, kind: "message", from: "a", text: "x", mention: false, own: false };
    render(<ChatBuffer label="m" lines={[line]} />);
    const log = screen.getByRole("log");
    expect(log.className).toContain("win95-scroll");
    expect(log.className).toContain("text-[15px]");
    expect(log.className).toContain("leading-[21px]");
    expect(log.firstElementChild?.className).toContain("mt-auto");
    expect(log.querySelector("[style]")).toBeNull();
  });

  it("scrolls by a page with PageUp and PageDown", () => {
    render(<ChatBuffer label="m" lines={[]} />);
    const log = screen.getByRole("log");
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 221 });
    log.scrollTop = 1000;
    fireEvent.keyDown(log, { key: "PageUp" });
    expect(log.scrollTop).toBe(800);
    fireEvent.keyDown(log, { key: "PageDown" });
    expect(log.scrollTop).toBe(1000);
  });

  it("scrolls one row with the arrow keys", () => {
    render(<ChatBuffer label="m" lines={[]} />);
    const log = screen.getByRole("log");
    log.scrollTop = 100;
    fireEvent.keyDown(log, { key: "ArrowUp" });
    expect(log.scrollTop).toBe(79);
    fireEvent.keyDown(log, { key: "ArrowDown" });
    expect(log.scrollTop).toBe(100);
  });
});
