import { Numerics, isParseError } from "@seance/irc-protocol";
import type { IrcMessage, ParseError } from "@seance/irc-protocol";
import type { ChannelRegistry } from "./channel-registry.js";
import type { Client } from "./client.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { EventBus } from "./event-bus.js";

/** Minimal structured logger; never pass message params or secrets. */
export interface RouterLogger {
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/**
 * Decides whether an unregistered `target` nick is claimed (e.g. an agent that
 * is not connected yet) so `INVITE` may proceed. Must return synchronously.
 */
export type InviteResolver = (target: string, channel: string, inviter: string) => boolean;

/** Shared state and services handed to every handler. */
export interface RouterContext {
  readonly connections: ConnectionManager;
  readonly channels: ChannelRegistry;
  readonly serverName: string;
  /** When set, clients must supply a matching `PASS` to register (Req 3.1). */
  readonly serverPassword?: string;
  /** MOTD lines sent after the welcome burst; defaults to a short Séance message. */
  readonly motd?: readonly string[];
  /** Server start time, reported in `003`; defaults to the module load time. */
  readonly createdAt?: Date;
  readonly logger: RouterLogger;
  /** Event bus for `irc.*` events; handlers skip publishing when unset. */
  readonly events?: EventBus;
  /** Injectable clock in milliseconds; defaults to `Date.now` (Req 4.5). */
  readonly now?: () => number;
  /** Claims unregistered invite targets (Req 5.3); unset means none are claimed. */
  readonly inviteResolver?: InviteResolver;
}

export type CommandHandlerFn = (
  ctx: RouterContext,
  client: Client,
  msg: IrcMessage,
) => void;

/** A handler plus the minimum parameter count it declares (Req 3.6). */
export interface CommandHandler {
  readonly minParams: number;
  readonly run: CommandHandlerFn;
}

/** Commands an unregistered client may use (Req 3.7). */
export const PRE_REGISTRATION_COMMANDS: ReadonlySet<string> = new Set([
  "PASS",
  "NICK",
  "USER",
  "PING",
  "PONG",
  "QUIT",
]);

/** What happened to one dispatched input; useful for diagnostics and tests. */
export type DispatchOutcome =
  | "handled"
  | "dropped"
  | "not-registered"
  | "unknown-command"
  | "need-more-params"
  | "handler-error";

/**
 * Maps an uppercase command to its handler, enforcing registration gating
 * (Req 3.7), unknown commands (Req 1.6) and minimum parameters (Req 3.6).
 * Handler exceptions are contained per message.
 */
export class CommandRouter {
  private readonly handlers = new Map<string, CommandHandler>();
  private droppedCount = 0;

  /** Register a handler. The command is stored upper-case (Req 1.7). */
  register(command: string, handler: CommandHandler): this {
    const key = command.toUpperCase();
    if (this.handlers.has(key)) {
      throw new Error(`Cannot register "${key}": a handler already exists`);
    }
    if (!Number.isInteger(handler.minParams) || handler.minParams < 0) {
      throw new Error(`Cannot register "${key}": minParams must be a non-negative integer`);
    }
    this.handlers.set(key, handler);
    return this;
  }

  /** Number of inputs dropped as parse errors (diagnostics, Req 1.5). */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Route one parsed message (or parse failure) from `client`. Never throws. */
  dispatch(
    ctx: RouterContext,
    client: Client,
    input: IrcMessage | ParseError,
  ): DispatchOutcome {
    // Any complete line, even a malformed one, shows the peer is alive (Req 4.3).
    ctx.connections.touch(client);
    if (isParseError(input)) {
      this.droppedCount += 1;
      return "dropped";
    }
    const command = input.command.toUpperCase();
    const msg: IrcMessage =
      command === input.command ? input : { ...input, command };

    try {
      if (!client.registered && !PRE_REGISTRATION_COMMANDS.has(command)) {
        this.reply(ctx, client, Numerics.ERR_NOTREGISTERED, "You have not registered");
        return "not-registered";
      }
      const handler = this.handlers.get(command);
      if (handler === undefined) {
        this.reply(ctx, client, Numerics.ERR_UNKNOWNCOMMAND, command, "Unknown command");
        return "unknown-command";
      }
      if (msg.params.length < handler.minParams) {
        this.reply(ctx, client, Numerics.ERR_NEEDMOREPARAMS, command, "Not enough parameters");
        return "need-more-params";
      }
      handler.run(ctx, client, msg);
      return "handled";
    } catch (error) {
      try {
        ctx.logger.error(
          { command, clientId: client.id, error },
          `Handler for ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // A failing logger must not take the server down either.
      }
      return "handler-error";
    }
  }

  private reply(
    ctx: RouterContext,
    client: Client,
    numeric: string,
    ...rest: readonly string[]
  ): void {
    client.send({
      prefix: ctx.serverName,
      command: numeric,
      params: [client.nick ?? "*", ...rest],
    });
  }
}
