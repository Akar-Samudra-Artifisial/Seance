import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "./Icon.js";

const names: readonly IconName[] = [
  "connect",
  "options",
  "channels",
  "agents",
  "logs",
  "theme",
  "status",
  "hash",
  "ghost-coder",
  "ghost-reviewer",
  "ghost-researcher",
  "ghost-away",
];

describe("Icon", () => {
  it.each(names)("%s renders aria-hidden with no style attribute", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("style")).toBe(false);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("path")).not.toBeNull();
  });

  it("colours ghosts with token classes and the away ghost grey", () => {
    const { container } = render(
      <>
        <Icon name="ghost-coder" />
        <Icon name="ghost-away" />
      </>,
    );
    const [coder, away] = Array.from(container.querySelectorAll("svg"));
    expect(coder?.getAttribute("class")).toContain("text-nick-coder");
    expect(away?.getAttribute("class")).toContain("text-away-grey");
  });
});
