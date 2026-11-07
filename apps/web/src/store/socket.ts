/** Close event data the Store needs. */
export interface SocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/**
 * Minimal WebSocket port. The Store assigns the handlers after creation; the
 * adapter (or a test fake) calls them. `onmessage` data is `unknown` because a
 * browser may deliver a Blob or ArrayBuffer, which the Store rejects.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: SocketCloseInfo) => void) | null;
}

export type CreateSocket = (url: string) => WebSocketLike;

/** Browser adapter around the global `WebSocket`. Throws if the URL is rejected by the browser. */
export const createBrowserSocket: CreateSocket = (url) => {
  const ws = new WebSocket(url);
  const port: WebSocketLike = {
    send: (data) => {
      ws.send(data);
    },
    close: (code, reason) => {
      ws.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  ws.onopen = () => {
    port.onopen?.();
  };
  ws.onmessage = (event: MessageEvent<unknown>) => {
    port.onmessage?.({ data: event.data });
  };
  ws.onerror = () => {
    port.onerror?.();
  };
  ws.onclose = (event: CloseEvent) => {
    port.onclose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean });
  };
  return port;
};
