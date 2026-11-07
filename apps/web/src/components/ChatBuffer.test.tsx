import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
