import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TopicBar } from "./TopicBar.js";

afterEach(cleanup);

describe("TopicBar", () => {
  it("shows the topic text", () => {
    render(<TopicBar topic="Ship the build" />);
    expect(screen.getByLabelText("Channel topic").textContent).toBe("Ship the build");
  });

  it("shows a placeholder when no topic is set", () => {
    render(<TopicBar topic={undefined} />);
    expect(screen.getByLabelText("Channel topic").textContent).toBe("(no topic set)");
  });

  it("shows the placeholder for an empty topic", () => {
    render(<TopicBar topic="" />);
    expect(screen.getByLabelText("Channel topic").textContent).toBe("(no topic set)");
  });

  it("renders markup in the topic as text", () => {
    render(<TopicBar topic="<b>hi</b>" />);
    const bar = screen.getByLabelText("Channel topic");
    expect(bar.textContent).toBe("<b>hi</b>");
    expect(bar.querySelector("b")).toBeNull();
  });
});
