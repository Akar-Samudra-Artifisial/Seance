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

  it("is a named list with channel and member count", () => {
    render(<NickList channel="#dev" members={sample} />);
    expect(screen.getByRole("list", { name: "Members of #dev, 4 members" })).toBeTruthy();
    expect(screen.getByText("4 nicks")).toBeTruthy();
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

  it("handles an empty or missing member set", () => {
    render(<NickList channel="#dev" members={undefined} />);
    expect(screen.getByRole("list", { name: "Members of #dev, 0 members" })).toBeTruthy();
    expect(screen.getByText("0 nicks")).toBeTruthy();
  });

  it("uses singular wording for one member", () => {
    render(<NickList channel="#dev" members={members({ nick: "me", op: true, voice: false })} />);
    expect(screen.getByRole("list", { name: "Members of #dev, 1 member" })).toBeTruthy();
    expect(screen.getByText("1 nick")).toBeTruthy();
  });
});
