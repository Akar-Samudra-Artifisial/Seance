import { connect } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { IrcServer } from "../src/server.js";

// Feature: ircd-agent-commands-fixes, Finding 6 (exploration): transient TCP resets log at error.
// Requirement 1.12. Written before the fix. Sockets bind to port 0 and are closed in afterEach.

type Fields = Record<string, unknown>;
type LogFn = (fields: Fields, message: string) => void;
type Logger = { error: LogFn; debug?: LogFn };
type LogSocketError = (logger: Logger, label: string, clientId: string, error: Error) => void;

describe("Finding 6: socket error levels (exploration)", () => {
  let server: IrcServer | undefined;
  let socket: Socket | undefined;

  afterEach(async () => {
    socket?.destroy();
    socket = undefined;
    await server?.stop();
    server = undefined;
  });

  /** Register a TCP client, reset the connection, and wait until the server dropped it. */
  async function resetClient() {
    const error = vi.fn<LogFn>();
    const debug = vi.fn<LogFn>();
    const logger: Logger = { error, debug };
    server = createServer(loadConfig({ IRCD_TCP_PORT: "0", IRCD_WS_PORT: "0", IRCD_HOST: "127.0.0.1" }), logger);
    const { tcpPort } = await server.start();
    const sock = connect(tcpPort, "127.0.0.1");
    socket = sock;
    sock.setEncoding("utf8");
    let received = "";
    sock.on("data", (d: string) => {
      received += d;
    });
    sock.on("error", () => {});
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    sock.write("NICK rst\r\nUSER rst 0 * :Reset\r\n");
    await vi.waitFor(() => expect(received).toContain(" 001 "), { timeout: 3000 });
    const clientId = server.ctx.connections.getByNick("rst")?.id;
    expect(clientId).toBeDefined();
    sock.resetAndDestroy();
    await vi.waitFor(() => expect(server?.ctx.connections.getByNick("rst")).toBeUndefined(), {
      timeout: 3000,
    });
    return { error, debug, clientId: clientId ?? "" };
  }

  it("1.12 a client reset does not write an error entry", async () => {
    const { error } = await resetClient();
    const socketErrors = error.mock.calls.filter(([, message]) => /socket error/i.test(message));
    expect(socketErrors.map(([f]) => f["error"] instanceof Error ? (f["error"] as NodeJS.ErrnoException).code : f)).toEqual([]);
  });

  it("1.12 a client reset is logged at debug with the client id", async () => {
    const { debug, clientId } = await resetClient();
    expect(debug).toHaveBeenCalled();
    expect(debug.mock.calls.some(([fields]) => fields["clientId"] === clientId)).toBe(true);
  });

  async function loadLogSocketError(): Promise<LogSocketError | undefined> {
    const spec = "../src/socket-errors.js";
    try {
      const mod = (await import(/* @vite-ignore */ spec)) as { logSocketError?: LogSocketError };
      return mod.logSocketError;
    } catch (error) {
      // Only a missing module counts as "not implemented yet"; anything else is a real failure.
      if (error instanceof Error && /Failed to (load|resolve)|Cannot find|not found/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
  }

  const withCode = (code?: string): Error =>
    code === undefined ? new Error("plain") : Object.assign(new Error(code), { code });

  it.each(["ECONNRESET", "EPIPE"])("1.12 logSocketError logs %s at debug", async (code) => {
    const fn = await loadLogSocketError();
    expect(fn, "logSocketError (src/socket-errors.ts) is not implemented yet").toBeTypeOf("function");
    const error = vi.fn<LogFn>();
    const debug = vi.fn<LogFn>();
    fn?.({ error, debug }, "TCP socket", "c1", withCode(code));
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toMatchObject({ clientId: "c1" });
  });

  it.each([["ETIMEDOUT"], [undefined]])("1.12 logSocketError logs code %s at error", async (code) => {
    const fn = await loadLogSocketError();
    expect(fn, "logSocketError (src/socket-errors.ts) is not implemented yet").toBeTypeOf("function");
    const error = vi.fn<LogFn>();
    const debug = vi.fn<LogFn>();
    fn?.({ error, debug }, "TCP socket", "c1", withCode(code));
    expect(debug).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ clientId: "c1" });
  });
});
