import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../irc/index.js";
import { NickList } from "./NickList.js";
import type { NickAction } from "./NickList.js";

afterEach(cleanup);

// Audit 10.5: double-click and Enter open a query; a context menu offers Whois, Query, voice and kick.

const sample: Record<string, Member> = {
  coder: { nick: "coder", op: true, voice: false },
  reviewer: { nick: "reviewer", op: false, voice: true },
  zed: { nick: "zed", op: false, voice: false },
};

function setup(canModerate: boolean) {
  const calls: [NickAction, string][] = [];
  const onAction = vi.fn((action: NickAction, nick: string) => {
    calls.push([action, nick]);
  });
  render(<NickList channel="#dev" members={sample} onAction={onAction} canModerate={canModerate} />);
  const row = (nick: string): HTMLElement => within(screen.getByRole("list")).getByRole("button", { name: new RegExp(nick) });
  return { calls, row };
}

describe("NickList actions", () => {
  it("double-click opens a query", () => {
    const { calls, row } = setup(true);
    fireEvent.doubleClick(row("zed"));
    expect(calls).toEqual([["query", "zed"]]);
  });

  it("Enter opens a query and the arrow keys move between rows", () => {
    const { calls, row } = setup(true);
    row("coder").focus();
    fireEvent.keyDown(row("coder"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("reviewer"));
    fireEvent.keyDown(row("reviewer"), { key: "Enter" });
    expect(calls).toEqual([["query", "reviewer"]]);
  });

  it("right-click, Shift+F10 and the Menu key open a menu with Whois and Query", () => {
    for (const open of [
      (el: HTMLElement) => fireEvent.contextMenu(el),
      (el: HTMLElement) => fireEvent.keyDown(el, { key: "F10", shiftKey: true }),
      (el: HTMLElement) => fireEvent.keyDown(el, { key: "ContextMenu" }),
    ]) {
      const { row } = setup(true);
      open(row("zed"));
      const menu = screen.getByRole("menu", { name: "Actions for zed" });
      expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
        "Whois",
        "Query",
        "Give voice",
        "Kick",
      ]);
      cleanup();
    }
  });

  it("offers Take voice for a voiced nick", () => {
    const { row } = setup(true);
    fireEvent.contextMenu(row("reviewer"));
    expect(screen.getByRole("menuitem", { name: "Take voice" })).toBeTruthy();
  });

  it("runs a menu item and returns focus to the row; Escape closes with focus return", () => {
    const { calls, row } = setup(true);
    fireEvent.contextMenu(row("zed"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Whois" }));
    expect(calls).toEqual([["whois", "zed"]]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row("zed"));

    fireEvent.contextMenu(row("zed"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row("zed"));
  });

  it("makes voice and kick inert with a reason unless the user is a channel operator", () => {
    const { calls, row } = setup(false);
    fireEvent.contextMenu(row("zed"));
    for (const name of ["Give voice", "Kick"]) {
      const item = screen.getByRole("menuitem", { name });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(item);
    }
    expect(calls).toEqual([]);
  });

  // Audit 10.17: placement, nick leaving, unique ids.
  describe("menu placement", () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = realRect;
      // Drop the own property so the prototype getter (0 in jsdom) is back.
      Reflect.deleteProperty(document.documentElement, "clientWidth");
    });
    const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
      ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect;
    const boxOf = (): HTMLElement => screen.getByRole("menu").parentElement as HTMLElement;

    it("opens at the pointer for a right-click", () => {
      const { row } = setup(true);
      fireEvent.contextMenu(row("zed"), { clientX: 50, clientY: 60 });
      expect(boxOf().style.left).toBe("50px");
      expect(boxOf().style.top).toBe("60px");
    });

    it("opens under the row for Shift+F10", () => {
      HTMLElement.prototype.getBoundingClientRect = function r(this: HTMLElement): DOMRect {
        return this.tagName === "BUTTON" && this.getAttribute("role") === null ? rect(12, 20, 60, 42) : rect(0, 0, 0, 0);
      };
      const { row } = setup(true);
      fireEvent.keyDown(row("zed"), { key: "F10", shiftKey: true });
      expect(boxOf().style.left).toBe("12px");
      expect(boxOf().style.top).toBe("42px");
    });

    it("is shifted back inside the viewport", () => {
      Object.defineProperty(document.documentElement, "clientWidth", { value: 300, configurable: true });
      HTMLElement.prototype.getBoundingClientRect = function r(this: HTMLElement): DOMRect {
        return this.getAttribute("role") === "menu" ? rect(250, 10, 350, 900) : rect(0, 0, 0, 0);
      };
      const { row } = setup(true);
      fireEvent.contextMenu(row("zed"), { clientX: 250, clientY: 10 });
      expect(boxOf().style.left).toBe("200px"); // 250 - (350 - 300)
      expect(boxOf().style.top).toBe("0px"); // too tall for the window: pinned to the top edge
    });
  });

  it("closes the menu and returns focus to the list when the nick leaves", () => {
    const { rerender } = render(<NickList channel="#dev" members={sample} onAction={() => undefined} canModerate />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /zed/ }));
    expect(screen.getByRole("menu", { name: "Actions for zed" })).toBeTruthy();
    const rest = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== "zed"));
    rerender(<NickList channel="#dev" members={rest} onAction={() => undefined} canModerate />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("list"));
  });

  it("gives the pane and the overlay different menu ids", () => {
    render(
      <>
        <NickList channel="#dev" members={sample} onAction={() => undefined} />
        <NickList channel="#dev" members={sample} variant="overlay" onAction={() => undefined} />
      </>,
    );
    const rows = screen.getAllByRole("button", { name: /zed/ });
    fireEvent.contextMenu(rows[0] as HTMLElement);
    fireEvent.contextMenu(rows[1] as HTMLElement);
    const ids = screen.getAllByRole("menu").map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("stays a plain list without onAction", () => {
    render(<NickList channel="#dev" members={sample} />);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
