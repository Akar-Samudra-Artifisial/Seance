import { createHash, timingSafeEqual } from "node:crypto";
import { Numerics, irc_lower, isServiceNick, isValidNick } from "@seance/irc-protocol";
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
  numeric(ctx, client, Numerics.RPL_MYINFO, ctx.serverName, SERVER_VERSION, "o", "mntov");
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
  // runner-services Req 3.1: last step, once per client; a rejected registration never gets here.
  ctx.events?.publish("irc.register", { nick, virtual: client.virtual === true });
}

// ---- public-hardening Requirements 1 and 2: Auth_Mode ---------------------------------------

/** Wrong PASS values a connection may send before it is closed (Requirement 1.4). */
export const MAX_PASS_STRIKES = 3;

type AuthKind = "none" | "pending" | "guest" | "account";

interface AuthState {
  kind: AuthKind;
  /** Account nick (display spelling) once `kind` is "account". */
  account?: string;
  strikes: number;
  /** NICK received before registration; the nick is claimed only when registration completes. */
  pendingNick?: string;
  /** Commands that arrived while the account login was being verified (Requirement 13). */
  held?: { readonly msg: IrcMessage; readonly replay: (msg: IrcMessage) => void }[];
}

/** At most this many lines are held during an account login; more get 451 (Requirement 13.1). */
export const MAX_HELD_LINES = 20;

/**
 * public-hardening Requirement 13: while an account `PASS` is still being verified (scrypt is
 * asynchronous), a command that needs registration is held and replayed through `replay` once
 * the client is registered, instead of getting 451. Returns "not-pending" when no login is in
 * flight (the caller then replies 451 as before) and "full" when the queue is full.
 */
export function holdUntilLoggedIn(
  client: Client,
  msg: IrcMessage,
  replay: (msg: IrcMessage) => void,
): "held" | "full" | "not-pending" {
  const state = authStates.get(client);
  // "account": logged in, but NICK/USER not complete yet (or a reserved nick was refused).
  if (client.registered || state === undefined || (state.kind !== "pending" && state.kind !== "account")) return "not-pending";
  state.held ??= [];
  if (state.held.length >= MAX_HELD_LINES) return "full";
  state.held.push({ msg, replay });
  return "held";
}

/** Replays held commands after registration, or answers each with 451 when the login failed. */
function releaseHeld(ctx: RouterContext, client: Client, state: AuthState): void {
  const held = state.held ?? [];
  delete state.held;
  for (const { msg, replay } of held) {
    if (ctx.connections.get(client.id) !== client) return; // closed meanwhile
    if (client.registered) replay(msg);
    else numeric(ctx, client, Numerics.ERR_NOTREGISTERED, "You have not registered");
  }
}

const authStates = new WeakMap<Client, AuthState>();

function authOf(client: Client): AuthState {
  let state = authStates.get(client);
  if (state === undefined) {
    state = { kind: "none", strikes: 0 };
    authStates.set(client, state);
  }
  return state;
}

/** A server password or accounts are configured: nicks are claimed only after PASS (Requirement 1.1). */
export function isAuthMode(ctx: RouterContext): boolean {
  return ctx.serverPassword !== undefined || ctx.accounts !== undefined;
}

/** Trusted in-process clients (agents) need no PASS and may use agent nicks (Requirement 1.5). */
function needsAuth(ctx: RouterContext, client: Client): boolean {
  return isAuthMode(ctx) && client.trusted !== true;
}

function isAgentNick(ctx: RouterContext, nick: string): boolean {
  const key = irc_lower(nick);
  for (const reserved of ctx.reservedNicks?.() ?? []) if (irc_lower(reserved) === key) return true;
  return false;
}

/**
 * Why `nick` is not allowed for this client, as a numeric and text, or undefined when it is.
 * Guests get 433 for an account nick and 432 for an agent nick; an account may use only its own
 * nick (Requirements 2.3, 2.4). Trusted clients and clients outside Auth_Mode are not restricted.
 */
function reservedReason(
  ctx: RouterContext,
  client: Client,
  nick: string,
): { readonly code: string; readonly text: string } | undefined {
  if (!needsAuth(ctx, client)) return undefined;
  const state = authOf(client);
  if (state.kind === "account") {
    if (state.account !== undefined && irc_lower(state.account) !== irc_lower(nick)) {
      return { code: Numerics.ERR_ERRONEUSNICKNAME, text: `Nickname must be your account ${state.account}` };
    }
    return undefined;
  }
  if (ctx.accounts?.has(nick) === true) return { code: Numerics.ERR_NICKNAMEINUSE, text: "Nickname is reserved for an account" };
  if (isAgentNick(ctx, nick)) return { code: Numerics.ERR_ERRONEUSNICKNAME, text: "Nickname is reserved for agents" };
  return undefined;
}

/** A wrong PASS: counted per connection and per address; the third closes the connection. */
function strike(ctx: RouterContext, client: Client): void {
  const state = authOf(client);
  state.kind = "none";
  state.strikes += 1;
  ctx.passFailures?.record(client.host);
  if (state.strikes >= MAX_PASS_STRIKES) {
    numeric(ctx, client, Numerics.ERR_PASSWDMISMATCH, "Password incorrect");
    client.close("Too many failed PASS attempts");
  }
}

/** True while `client` is still the tracked, unregistered connection (after an async verify). */
function stillPending(ctx: RouterContext, client: Client): boolean {
  return ctx.connections.get(client.id) === client && !client.registered;
}

/** PASS in Auth_Mode: the server password logs in a guest, `<nick>:<secret>` an account. */
function handleAuthPass(ctx: RouterContext, client: Client, given: string): void {
  const state = authOf(client);
  // One attempt at a time, and a logged-in connection keeps its login.
  if (state.kind !== "none") return;
  if (ctx.serverPassword !== undefined && safeEqual(given, ctx.serverPassword)) {
    state.kind = "guest";
    ctx.connections.acceptPass(client);
    tryRegister(ctx, client);
    return;
  }
  const colon = given.indexOf(":");
  const accounts = ctx.accounts;
  if (accounts === undefined || colon < 1) {
    strike(ctx, client);
    return;
  }
  const nick = given.slice(0, colon);
  const secret = given.slice(colon + 1);
  state.kind = "pending";
  accounts.verify(nick, secret).then(
    (ok) => {
      if (!stillPending(ctx, client)) return;
      if (!ok) {
        strike(ctx, client);
        releaseHeld(ctx, client, state); // the login failed: each held line gets its 451 now
        // NICK and USER may have arrived meanwhile: they now fail like a wrong guest password.
        if (stillPending(ctx, client) && state.strikes < MAX_PASS_STRIKES) tryRegister(ctx, client);
        return;
      }
      state.kind = "account";
      state.account = accounts.nameOf(nick) ?? nick;
      ctx.connections.acceptPass(client);
      tryRegister(ctx, client);
    },
    () => {
      if (!stillPending(ctx, client)) return;
      strike(ctx, client);
      releaseHeld(ctx, client, state);
    },
  );
}

/**
 * Completes registration in Auth_Mode: claims the pending nick only now, after a successful PASS
 * (Requirement 1.1). Without a login the connection gets 464 and is closed (Requirement 1.2). A
 * reserved or taken nick gets 432/433 and the connection may try another NICK.
 */
function tryRegisterAuth(ctx: RouterContext, client: Client): void {
  const state = authOf(client);
  const nick = state.pendingNick;
  if (client.registered || nick === undefined || client.user === undefined) return;
  if (state.kind === "pending") return; // the verification decides
  if (state.kind === "none") {
    numeric(ctx, client, Numerics.ERR_PASSWDMISMATCH, "Password incorrect");
    client.close("Password incorrect");
    return;
  }
  const reason = reservedReason(ctx, client, nick);
  if (reason !== undefined) {
    delete state.pendingNick;
    numeric(ctx, client, reason.code, nick, reason.text);
    return;
  }
  if (ctx.connections.setNick(client, nick) === "in-use") {
    delete state.pendingNick;
    numeric(ctx, client, Numerics.ERR_NICKNAMEINUSE, nick, "Nickname is already in use");
    return;
  }
  delete state.pendingNick;
  if (state.kind === "account" && state.account !== undefined) client.account = state.account;
  if (ctx.connections.tryCompleteRegistration(client, true)) {
    onRegistrationComplete(ctx, client);
    releaseHeld(ctx, client, state);
  }
}

/**
 * Finish registration when NICK and USER are both present. When a server
 * password is configured, a missing or wrong PASS yields 464 and the
 * connection is closed (Req 3.1).
 */
function tryRegister(ctx: RouterContext, client: Client): void {
  if (needsAuth(ctx, client)) {
    tryRegisterAuth(ctx, client);
    return;
  }
  if (client.registered || client.nick === undefined || client.user === undefined) {
    return;
  }
  // Trusted agent clients need no PASS (public-hardening Requirement 1.5).
  const passwordRequired = ctx.serverPassword !== undefined && client.trusted !== true;
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
  if (needsAuth(ctx, client)) {
    if (given !== undefined) handleAuthPass(ctx, client, given);
    return;
  }
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
  // runner-services Req 1.2, 1.3: the services' nicks belong to the network (any transport).
  if (isServiceNick(nick)) {
    numeric(ctx, client, Numerics.ERR_ERRONEUSNICKNAME, nick, "Nickname is reserved for network services");
    return;
  }
  // public-hardening Requirement 1.1: before registration in Auth_Mode the nick is only recorded.
  if (!client.registered && needsAuth(ctx, client)) {
    authOf(client).pendingNick = nick;
    tryRegister(ctx, client);
    return;
  }
  const oldNick = client.nick;
  if (client.registered && oldNick === nick) return; // unchanged: nothing to announce
  if (client.registered && needsAuth(ctx, client)) {
    // Requirement 2.5: an account keeps its nick (a case-only change is still the same nick).
    if (client.account !== undefined && irc_lower(client.account) !== irc_lower(nick)) {
      numeric(ctx, client, Numerics.ERR_ERRONEUSNICKNAME, nick, "Account nicks cannot be changed");
      return;
    }
    const reason = reservedReason(ctx, client, nick);
    if (reason !== undefined) {
      numeric(ctx, client, reason.code, nick, reason.text);
      return;
    }
  }
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
