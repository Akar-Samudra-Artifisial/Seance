import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Line } from "../irc/index.js";
import { ChatLine } from "./ChatLine.js";
import { WhoisBlock } from "./WhoisBlock.js";

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

describe("WhoisBlock", () => {
  it("is a labelled group with every field", () => {
    render(<WhoisBlock line={line} offsetMinutes={0} />);
    const group = screen.getByRole("group", { name: "WHOIS coder" });
    const text = group.textContent ?? "";
    expect(text).toContain("agent@seance.local");
    expect(text).toContain("Coder agent");
    expect(text).toContain("irc.seance (haunted)");
    expect(text).toContain("@#dev +#ops");
    expect(text).toContain("1h 2m 5s");
    expect(text).toContain("1970-01-02 00:00:00 UTC");
    expect(text).toContain("brb away");
    expect(text).not.toContain("\x02");
    expect(text).not.toContain("\x03");
  });

  it("shows the 320 special lines", () => {
    render(<WhoisBlock line={line} offsetMinutes={0} />);
    const text = screen.getByRole("group").textContent ?? "";
    for (const s of ["model: claude", "tools: shell, git", "credits: 12"]) {
      expect(text).toContain(s);
    }
  });

  it("omits absent fields and never injects markup", () => {
    const { container } = render(
      <WhoisBlock
        line={{
          ...line,
          whois: { nick: "<b>x</b>", channels: [], special: ["<img src=x>"] },
        }}
        offsetMinutes={0}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).not.toContain("away");
    expect(container.textContent).not.toContain("idle");
  });

  it("is rendered by ChatLine for whois lines", () => {
    render(<ChatLine line={line} offsetMinutes={0} />);
    expect(screen.getByRole("group", { name: "WHOIS coder" })).toBeTruthy();
  });
});
