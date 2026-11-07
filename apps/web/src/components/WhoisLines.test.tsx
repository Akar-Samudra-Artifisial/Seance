import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Line } from "../irc/index.js";
import { ChatLine } from "./ChatLine.js";
import { WhoisLines } from "./WhoisLines.js";

afterEach(cleanup);

const line: Line = {
  id: 1,
  at: 0,
  kind: "whois",
  text: "whois coder",
  mention: false,
  own: false,
  whois: {
    nick: "coder",
    user: { user: "agent", host: "seance.local", realname: "\x02Coder\x02 agent" },
    server: { name: "irc.seance", info: "haunted" },
    channels: ["@#dev", "+#ops"],
    away: "brb \x034away\x03",
    special: ["model: claude", "tools: shell, git", "credits: 12"],
    idle: { seconds: 3725, signon: 86400 },
  },
};

function rowTexts(container: HTMLElement): string[] {
  return Array.from(container.children).map((c) => c.textContent ?? "");
}

describe("WhoisLines", () => {
  it("renders consecutive lines in order between two separators", () => {
    const { container } = render(<WhoisLines line={line} offsetMinutes={0} nickClassName="text-nick-coder" />);
    expect(rowTexts(container)).toEqual([
      "[00:00] -",
      "[00:00] coder is agent@seance.local * Coder agent",
      "[00:00] coder on @#dev +#ops",
      "[00:00] coder using irc.seance haunted",
      "[00:00] coder is away: brb away",
      "[00:00] coder model: claude",
      "[00:00] coder tools: shell, git",
      "[00:00] coder credits: 12",
      "[00:00] coder has been idle 3725secs, signed on 1970-01-02 00:00:00 UTC",
      "[00:00] coder End of /WHOIS list.",
      "[00:00] -",
    ]);
    expect(container.textContent).not.toContain("\x02");
    expect(container.textContent).not.toContain("\x03");
  });

  it("shows the nick in bold with its nick colour", () => {
    const { container } = render(<WhoisLines line={line} offsetMinutes={0} nickClassName="text-nick-coder" />);
    const nick = container.querySelector("b");
    expect(nick?.className).toContain("font-bold");
    expect(nick?.className).toContain("text-nick-coder");
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("[role='group']")).toBeNull();
  });

  it("omits absent fields and never injects markup", () => {
    const { container } = render(
      <WhoisLines
        line={{ ...line, whois: { nick: "<b>x</b>", channels: [], special: ["<img src=x>"] } }}
        offsetMinutes={0}
        nickClassName="text-nick-human"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("b")).toHaveLength(container.children.length - 2);
    expect(container.textContent).not.toContain("away");
    expect(container.textContent).not.toContain("idle");
  });

  it("is rendered by ChatLine for whois lines", () => {
    render(<ChatLine line={line} offsetMinutes={0} />);
    expect(screen.getByText("End of /WHOIS list.")).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });
});
