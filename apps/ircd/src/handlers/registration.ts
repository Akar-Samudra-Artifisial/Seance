import { createHash, timingSafeEqual } from "node:crypto";
import { Numerics, isValidNick } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import { nowSeconds } from "../clock.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { numeric } from "../replies.js";
import { AWAYLEN, KICKLEN, TOPICLEN, clampBytes } from "../text-limits.js";
import { quitClient } from "./quit.js";

const SERVER_VERSION = "seance-ircd-0.1";
const DEFAULT_CREATED_AT = new Date();
/** IRC formatting: colour 07 (orange) and bold toggle. Each 372 line starts with default formatting. */
const ORANGE = "\x0307";
const BOLD = "\x02";
const PUMPKIN: readonly string[] = [
  String.raw`          (`,
  String.raw`     .--'-'--.`,
  String.raw`   .'  _   _  '.`,
  "  /   /_\\ /_\\   \\",
  String.raw` |       ^       |`,
  String.raw` |  \/\/\/\/\/\  |`,
  String.raw`  \  \/\/\/\/\/ /`,
  String.raw`   '.         .'`,
  String.raw`     '-------'`,
];
/**
 * Default MOTD from mockup frame `02 Status/MOTD`: an orange jack-o'-lantern, a bold headline and the
 * command cheat-sheet. Colours are IRC codes so any client renders them (web-client-polish R14.3).
 */
export const DEFAULT_MOTD: readonly string[] = [
  ...PUMPKIN.map((line) => `${ORANGE}${line}`),
  "",
  `${BOLD}This server is haunted.${BOLD}`,
  "Every user here is a ghost in the machine, except you.",
  "/invite <agent> to summon · /kick <agent> to exorcise",
  "/mode +v lets a spirit speak · +o lets it touch your files",
  "Credits are the candle. When it burns out, the séance ends.",
];
/** Keep MOTD text well inside the 512-byte line limit (prefix, nick, CRLF). */
const MAX_MOTD_TEXT_BYTES = 400;

/** Compare secrets without leaking length or content through timing. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Longest accepted `USER` username, in bytes. */
export const USERLEN = 18;
/** Longest accepted real name, in UTF-8 bytes. */
export const REALNAMELEN = 50;

const USERNAME = /^[A-Za-z0-9._~-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Returns a reason when the `USER` fields are unacceptable, otherwise undefined. */
export function validateUser(user: string, realname: string): string | undefined {
  if (user.length === 0 || user.length > USERLEN || !USERNAME.test(user)) {
    return "Invalid username";
  }
  if (Buffer.byteLength(realname, "utf8") > REALNAMELEN || CONTROL_CHARS.test(realname)) {
    return "Invalid realname";
  }
  return undefined;
}

/**
 * Welcome burst and MOTD (Req 3.9): 001–005, then 375, 372 (per line), 376.
 * Called exactly once per client, on the transition to registered.
 */
export function onRegistrationComplete(ctx: RouterContext, client: Client): void {
  const nick = client.nick ?? "*";
  const now = nowSeconds(ctx);
  client.signonAt = now;
  client.lastActivityAt = now;
  numeric(ctx, client, Numerics.RPL_WELCOME, `Welcome to the Séance IRC network, ${nick}`);
  numeric(
    ctx,
    client,
    Numerics.RPL_YOURHOST,
    `Your host is ${ctx.serverName}, running version ${SERVER_VERSION}`,
  );
  numeric(
    ctx,
    client,
    Numerics.RPL_CREATED,
    `This server was created ${(ctx.createdAt ?? DEFAULT_CREATED_AT).toISOString()}`,
  );
  numeric(ctx, client, Numerics.RPL_MYINFO, ctx.serverName, SERVER_VERSION, "o", "ov");
  numeric(
    ctx,
    client,
    Numerics.RPL_ISUPPORT,
    "CASEMAPPING=rfc1459",
    "CHANTYPES=#",
    "NICKLEN=30",
    `TOPICLEN=${TOPICLEN}`,
    `KICKLEN=${KICKLEN}`,
    `AWAYLEN=${AWAYLEN}`,
    "PREFIX=(ov)@+",
    "are supported by this server",
  );
  numeric(
    ctx,
    client,
    Numerics.RPL_MOTDSTART,
    `- ${ctx.serverName} Message of the day -`,
  );
  for (const line of ctx.motd ?? DEFAULT_MOTD) {
    numeric(
      ctx,
      client,
      Numerics.RPL_MOTD,
      `- ${clampBytes(line, MAX_MOTD_TEXT_BYTES)}`,
    );
  }
  numeric(ctx, client, Numerics.RPL_ENDOFMOTD, "End of /MOTD command");
}

/**
 * Finish registration when NICK and USER are both present. When a server
 * password is configured, a missing or wrong PASS yields 464 and the
 * connection is closed (Req 3.1).
 */
function tryRegister(ctx: RouterContext, client: Client): void {
  if (client.registered || client.nick === undefined || client.user === undefined) {
    return;
  }
  const passwordRequired = ctx.serverPassword !== undefined;
  if (passwordRequired && !ctx.connections.hasPass(client)) {
    numeric(ctx, client, Numerics.ERR_PASSWDMISMATCH, "Password incorrect");
    client.close("Password incorrect");
    return;
  }
  if (ctx.connections.tryCompleteRegistration(client, passwordRequired)) {
    onRegistrationComplete(ctx, client);
  }
}

/** `PASS <password>`: Req 3.1, 3.2. */
function handlePass(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  if (client.registered) {
    numeric(ctx, client, Numerics.ERR_ALREADYREGISTRED, "You may not reregister");
    return;
  }
  const given = msg.params[0];
  // Only a matching password counts as "received"; a wrong one leaves the
  // client without PASS so completion fails with 464.
  if (
    ctx.serverPassword === undefined ||
    (given !== undefined && safeEqual(given, ctx.serverPassword))
  ) {
    ctx.connections.acceptPass(client);
  }
}

/** `NICK <nickname>`: Req 3.3, 3.4, 3.5, 3.10. */
function handleNick(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const nick = msg.params[0];
  if (nick === undefined) {
    numeric(ctx, client, Numerics.ERR_NONICKNAMEGIVEN, "No nickname given");
    return;
  }
  if (!isValidNick(nick)) {
    numeric(ctx, client, Numerics.ERR_ERRONEUSNICKNAME, nick, "Erroneous nickname");
    return;
  }
  const oldNick = client.nick;
  if (client.registered && oldNick === nick) return; // unchanged: nothing to announce
  if (ctx.connections.setNick(client, nick) === "in-use") {
    numeric(ctx, client, Numerics.ERR_NICKNAMEINUSE, nick, "Nickname is already in use");
    return;
  }
  if (client.registered && oldNick !== undefined) {
    ctx.channels.renameNick(client.id, oldNick, nick);
    // Req 3.10: tell the client and each peer sharing a channel, once.
    ctx.connections.broadcastToPeers(
      client,
      {
        prefix: `${oldNick}!${client.user ?? oldNick}@${client.host ?? ctx.serverName}`,
        command: "NICK",
        params: [nick],
      },
      { includeSelf: true },
    );
    return;
  }
  tryRegister(ctx, client);
}

/** `USER <user> <mode> <unused> :<realname>`: Req 3.2, 3.6, 3.8. */
function handleUser(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const user = msg.params[0];
  const realname = msg.params[3];
  if (user === undefined || realname === undefined) return; // unreachable: router enforces minParams
  if (client.registered) {
    numeric(ctx, client, Numerics.ERR_ALREADYREGISTRED, "You may not reregister");
    return;
  }
  const problem = validateUser(user, realname);
  if (problem !== undefined) {
    // RFC 2812 has no numeric for a bad username, so end the attempt.
    quitClient(ctx, client, problem);
    return;
  }
  if (ctx.connections.setUser(client, user) === "already-registered") {
    numeric(ctx, client, Numerics.ERR_ALREADYREGISTRED, "You may not reregister");
    return;
  }
  client.realname = realname;
  tryRegister(ctx, client);
}

/** Register PASS, NICK and USER on the router. */
export function registerRegistrationHandlers(router: CommandRouter): void {
  router
    .register("PASS", { minParams: 1, run: handlePass })
    // minParams 0: a missing nick is 431, not the generic 461 (Req 3.5).
    .register("NICK", { minParams: 0, run: handleNick })
    .register("USER", { minParams: 4, run: handleUser });
}
