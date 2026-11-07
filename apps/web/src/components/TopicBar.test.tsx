import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TopicBar } from "./TopicBar.js";

afterEach(cleanup);

describe("TopicBar", () => {
  it("reads channel (modes): topic", () => {
    render(<TopicBar channel="#fix" modes="+mnt" topic="Ship the build" />);
    const bar = screen.getByLabelText("Channel topic");
    expect(bar.textContent).toBe("#fix (+mnt): Ship the build");
    expect(bar.getAttribute("title")).toBe("#fix (+mnt): Ship the build");
  });

  it("omits the topic when none is set", () => {
    render(<TopicBar channel="#fix" modes="+mnt" topic={undefined} />);
    expect(screen.getByLabelText("Channel topic").textContent).toBe("#fix (+mnt)");
  });

  it("omits empty topic and bare + modes", () => {
    render(<TopicBar channel="#fix" modes="+" topic="" />);
    expect(screen.getByLabelText("Channel topic").textContent).toBe("#fix");
  });

  it("omits modes when undefined", () => {
    render(<TopicBar channel="#fix" modes={undefined} topic="hi" />);
    expect(screen.getByLabelText("Channel topic").textContent).toBe("#fix: hi");
  });

  it("renders markup in the topic as text and strips control codes in title", () => {
    render(<TopicBar channel="#fix" modes={undefined} topic={"\u0002<b>hi</b>"} />);
    const bar = screen.getByLabelText("Channel topic");
    expect(bar.textContent).toBe("#fix: <b>hi</b>");
    expect(bar.querySelector("b")).toBeNull();
    expect(bar.getAttribute("title")).toBe("#fix: <b>hi</b>");
  });
});
