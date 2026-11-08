import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { THEME_KEY, createClientStorage } from "../store/storage.js";
import type { KeyValueBackend } from "../store/storage.js";
import { ThemeSync } from "./ThemeSync.js";
import { Toolbar } from "./Toolbar.js";

// Review finding 7: the server render is always Ghost (no localStorage on the server). With
// "classic" stored, the first client render must still match it, and Classic applies afterwards.

const ORIGIN = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
}

function makeStore(backend: KeyValueBackend | null) {
  return createClientStore({
    createSocket: () => new FakeSocket(),
    storage: createClientStorage(backend, [ORIGIN]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
}

function App(props: { readonly store: ReturnType<typeof makeStore> }) {
  return (
    <ClientStoreProvider store={props.store}>
      <Toolbar />
      <ThemeSync />
    </ClientStoreProvider>
  );
}

afterEach(() => {
  delete document.documentElement.dataset["theme"];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("theme hydration (review finding 7)", () => {
  it("hydrates without a mismatch when classic is stored, then applies Classic", async () => {
    // Server: no storage backend, so the markup says Ghost.
    const html = renderToString(<App store={makeStore(null)} />);
    expect(html).toContain("Ghost");
    // The server markup goes in through DOMParser (the lint rules forbid innerHTML, even in tests).
    const container = document.createElement("div");
    container.append(...Array.from(new DOMParser().parseFromString(html, "text/html").body.childNodes));
    document.body.append(container);

    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const recoverable: unknown[] = [];
    const client = makeStore({ getItem: (k) => (k === THEME_KEY ? "classic" : null), setItem: () => undefined });
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <App store={client} />, {
        onRecoverableError: (err) => {
          recoverable.push(err);
        },
      });
      await Promise.resolve();
    });

    const text = (args: unknown[]): string => args.map(String).join(" ");
    expect(recoverable).toEqual([]);
    expect(errors.filter((a) => /hydrat|did not match|mismatch/i.test(text(a)))).toEqual([]);
    expect(client.getState().ui.theme).toBe("classic");
    expect(document.documentElement.dataset["theme"]).toBe("classic");
    expect(container.textContent).toContain("Classic");
    act(() => {
      root?.unmount();
    });
  });
});
