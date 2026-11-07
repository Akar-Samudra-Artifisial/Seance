import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Member } from "../irc/index.js";
import { NickList } from "./NickList.js";

afterEach(cleanup);

function members(...list: Member[]): Record<string, Member> {
  return Object.fromEntries(list.map((m) => [m.nick.toLowerCase(), m]));
}

describe("NickList", () => {
  const sample = members(
    { nick: "zed", op: false, voice: false },
    { nick: "reviewer", op: false, voice: true },
    { nick: "Alice", op: false, voice: false },
    { nick: "coder", op: true, voice: false },
  );

  it("is a named list with channel and user count, plus footer", () => {
    render(<NickList channel="#dev" members={sample} />);
    expect(screen.getByRole("list", { name: "Members of #dev (4 users)" })).toBeTruthy();
    expect(screen.getByText("4 users · 2 agents")).toBeTruthy();
  });

  it("orders ops, voiced, others with @ and + prefixes", () => {
    render(<NickList channel="#dev" members={sample} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["@coder", "+reviewer", "Alice", "zed"]);
  });

  it("uses token classes for agent and human nicks", () => {
    render(<NickList channel="#dev" members={sample} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items[0]?.className).toContain("text-nick-coder");
    expect(items[1]?.className).toContain("text-nick-reviewer");
    expect(items[2]?.className).toContain("text-nick-human");
  });

  it("marks agents with an accessible ghost icon, grey while away", () => {
    const away = Object.assign(Object.create(null) as Record<string, string>, { reviewer: "" });
    render(<NickList channel="#dev" members={sample} away={away} />);
    expect(screen.getAllByRole("img", { name: "agent" })).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: "agent, away" })).toHaveLength(1);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items[1]?.className).toContain("text-away-grey");
  });

  it("shows exorcised rows below live members without counting them", () => {
    render(<NickList channel="#dev" members={members({ nick: "me", op: true, voice: false })} exorcised={["coder"]} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["@me", "coder"]);
    expect(items[1]?.className).toContain("line-through");
    expect(screen.getByText("1 users · 0 agents")).toBeTruthy();
  });

  it("handles an empty or missing member set", () => {
    render(<NickList channel="#dev" members={undefined} />);
    expect(screen.getByRole("list", { name: "Members of #dev (0 users)" })).toBeTruthy();
    expect(screen.getByText("0 users · 0 agents")).toBeTruthy();
  });
});
