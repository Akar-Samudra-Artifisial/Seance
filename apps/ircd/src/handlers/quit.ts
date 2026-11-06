import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { clampTrailing } from "../text-limits.js";

export const DEFAULT_QUIT_REASON = "Client Quit";

/** Clients whose quit is in progress or done; makes `quitClient` idempotent. */
const quitting = new WeakSet<Client>();

function logFailure(ctx: RouterContext, client: Client, step: string, error: unknown): void {
  try {
    ctx.logger.error(
      { command: "QUIT", clientId: client.id, step, error },
      `QUIT ${step} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } catch {
    // A failing logger must not stop the cleanup.
  }
}

/**
 * Disconnect a client in the required order (Req 11.1-11.5): broadcast `QUIT`
 * once per peer, remove it from every channel, close the connection, then
 * release the nick. Safe to call more than once (e.g. from a transport's
 * socket-close hook, which re-enters after `close`). A failure in one step is
 * logged and never skips the later steps.
 */
export function quitClient(ctx: RouterContext, client: Client, reason: string): void {
  if (quitting.has(client)) return;
  quitting.add(client);

  const nick = client.nick ?? "*";
  const prefix = `${nick}!${client.user ?? nick}@${client.host ?? ctx.serverName}`;
  const quitMsg: IrcMessage = {
    prefix,
    command: "QUIT",
    params: [clampTrailing(prefix, "QUIT", [], reason)],
  };

  try {
    // Dedupes peers and excludes the quitter (Req 11.1, 11.2).
    ctx.connections.broadcastToPeers(client, quitMsg);
  } catch (error) {
    logFailure(ctx, client, "broadcast", error);
  }
  try {
    ctx.channels.removeClient(client.id, client.nick); // deletes empty channels (Req 11.3)
  } catch (error) {
    logFailure(ctx, client, "channel removal", error);
  }
  try {
    client.close(reason); // Req 11.4
  } catch (error) {
    logFailure(ctx, client, "close", error);
  }
  try {
    ctx.connections.remove(client.id); // releases the nick (Req 11.5)
  } catch (error) {
    logFailure(ctx, client, "nick release", error);
  }
}

/** `QUIT [:reason]`: Req 11.1-11.5. Allowed before registration. */
function handleQuit(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  quitClient(ctx, client, msg.params[0] ?? DEFAULT_QUIT_REASON);
}

/** Register QUIT on the router. */
export function registerQuitHandler(router: CommandRouter): void {
  router.register("QUIT", { minParams: 0, run: handleQuit });
}
