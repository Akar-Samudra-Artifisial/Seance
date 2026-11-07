import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { InputLine } from "./InputLine.js";

afterEach(cleanup);

const ORIGIN = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

function setup() {
  const socket = new FakeSocket();
  const store = createClientStore({
    createSocket: () => socket,
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [ORIGIN]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  socket.onopen?.();
  const recv = (line: string): void => socket.onmessage?.({ data: `${line}\r\n` });
  recv(":srv 001 alice :Welcome");
  recv(":alice!a@h JOIN #dev");
  recv(":srv 353 alice = #dev :@alice coder cora");
  recv(":srv 366 alice #dev :End of /NAMES list");
  render(
    <ClientStoreProvider store={store}>
      <InputLine />
    </ClientStoreProvider>,
  );
  const input = screen.getByLabelText("Message or command") as HTMLInputElement;
  return { input, socket, store };
}

const type = (input: HTMLInputElement, value: string): void => {
  fireEvent.change(input, { target: { value } });
};

describe("InputLine", () => {
  it("consumes a draft from insertCommand, clears it and takes focus", () => {
    const { input, store } = setup();
    act(() => {
      store.getState().insertCommand("/join #");
    });
    expect(input.value).toBe("/join #");
    expect(document.activeElement).toBe(input);
    expect(store.getState().ui.draft).toBeNull();
  });

  it("recalls history with Up and Down and restores the draft", () => {
    const { input, socket } = setup();
    for (const line of ["one", "two"]) {
      type(input, line);
      fireEvent.submit(input);
    }
    expect(socket.sent).toContain("PRIVMSG #dev two\r\n");
    type(input, "draft");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("two");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("one");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("two");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("draft");
  });

  it("completes a nick with ': ' at line start, cycles, and keeps focus", () => {
    const { input } = setup();
    input.focus();
    type(input, "co");
    const notPrevented = fireEvent.keyDown(input, { key: "Tab" });
    expect(notPrevented).toBe(false);
    expect(input.value).toBe("coder: ");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("cora: ");
    expect(document.activeElement).toBe(input);
  });

  it("completes mid-line without a suffix and resets the cycle on another key", () => {
    const { input } = setup();
    type(input, "hi co");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("hi coder");
    fireEvent.keyDown(input, { key: "x" });
    fireEvent.keyDown(input, { key: "Tab" });
    // Cycle was reset: the word before the caret is now "hi coder", which matches nothing new.
    expect(input.value).toBe("hi coder");
  });
});
