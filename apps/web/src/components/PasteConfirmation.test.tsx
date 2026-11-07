import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import { createClientStorage } from "../store/storage.js";
import { PasteConfirmation } from "./PasteConfirmation.js";

afterEach(cleanup);

const ORIGIN = "ws://127.0.0.1:6668";

function setup(lineCount: number | null) {
  const store = createClientStore({
    createSocket: () => {
      throw new Error("no socket expected");
    },
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [ORIGIN]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  if (lineCount !== null) {
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i}`);
    store.setState((s) => ({
      client: { ...s.client, paste: { ...s.client.paste, pending: { lines, target: "#dev" } } },
    }));
  }
  render(
    <ClientStoreProvider store={store}>
      <PasteConfirmation />
    </ClientStoreProvider>,
  );
  return store;
}

describe("PasteConfirmation", () => {
  it("renders nothing when no paste is pending", () => {
    setup(null);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the line count and the 5-line limit", () => {
    setup(8);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("8 lines to #dev");
    expect(dialog.textContent).toContain("first 5 lines");
  });

  it("confirms with the button and clears the pending paste", () => {
    const store = setup(8);
    fireEvent.click(screen.getByRole("button", { name: "Send first 5" }));
    expect(store.getState().client.paste.pending).toBeUndefined();
  });

  it("declines with the Cancel button and reports unsent lines", () => {
    const store = setup(8);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.getState().client.paste.pending).toBeUndefined();
    const texts = store.getState().client.windows["status"]?.lines.map((l) => l.text) ?? [];
    expect(texts.some((t) => t.includes("8 lines not sent"))).toBe(true);
  });

  it("declines on Escape", () => {
    const store = setup(6);
    act(() => {
      fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    });
    expect(store.getState().client.paste.pending).toBeUndefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirms on Enter and focuses the confirm button first", () => {
    const store = setup(6);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send first 5" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter" });
    expect(store.getState().client.paste.pending).toBeUndefined();
  });
});
