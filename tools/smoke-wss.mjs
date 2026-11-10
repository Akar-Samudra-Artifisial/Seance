#!/usr/bin/env node
// End-to-end smoke test of a deployed Séance host over wss (spec deploy-aws, task 8).
//
//   SMOKE_SECRET=... node tools/smoke-wss.mjs <host> <nick> [agent]
//
//   <host>   host name without scheme, e.g. seance.example.com (wss://<host>/ws, Origin https://<host>)
//   <nick>   an account nick (PASS <nick>:<secret>); <agent> defaults to coder
//   SMOKE_TIMEOUT_S   overall timeout in seconds (default 120)
//
// Flow: log in, join a fresh #smoke<5 digits>, invite the agent, wait for BOTH the ChanServ line
// "worktree ready" and the agent's JOIN (a prompt sent earlier is ignored: no Session yet), give it
// +v, ask for one word, KICK the agent on its first reply to that prompt, and finish on the ChanServ
// "credits used" line. One line per step with the elapsed seconds. Exit 0 on success, 1 on a failure,
// 2 on a usage error. After any failure, Ctrl-C or SIGTERM the agent is kicked first (when it was
// invited), so no session is left running. Costs about 0.02 Kiro credits.
//
// The secret is read only from SMOKE_SECRET. The PASS line is sent but never printed or logged, and
// every text from the server is stripped of control characters, cut to 200 characters and has the
// secret replaced by <redacted> before it is printed.
import { createRequire } from "node:module";

const NICK = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,29}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const DEFAULT_TIMEOUT_S = 120;
const PROMPT_DELAY_MS = 1500;
const FLUSH_WAIT_MS = 500;
const MAX_PRINTED = 200;
const MAX_PARTIAL = 65536;
const PROMPT = "Reply with exactly the single word PONG and do nothing else.";
// JOIN errors (no such channel, too many channels, channel full, invite only, banned, bad key, ...).
const JOIN_ERRORS = new Set(["403", "405", "471", "473", "474", "475", "477"]);
// INVITE errors (no such nick, already on channel, not a channel operator).
const INVITE_ERRORS = new Set(["401", "443", "482"]);

const usage = (why) => {
  console.error(`${why}\nusage: SMOKE_SECRET=... node tools/smoke-wss.mjs <host> <nick> [agent]`);
  process.exit(2);
};

const [host, nick, agent = "coder"] = process.argv.slice(2);
const secret = process.env["SMOKE_SECRET"];
if (host === undefined || nick === undefined) usage("missing <host> or <nick>");
if (secret === undefined || secret === "") usage("SMOKE_SECRET is not set");
// The value is not echoed: it would be the secret itself.
if (/[\r\n\0 ]/.test(secret)) usage("SMOKE_SECRET must not contain CR, LF, NUL or a space");
if (!HOST.test(host)) usage("<host> must be a host name without scheme or path");
if (!NICK.test(nick) || !NICK.test(agent)) usage("<nick> and [agent] must be valid IRC nicks");
const timeoutS = process.env["SMOKE_TIMEOUT_S"] === undefined ? DEFAULT_TIMEOUT_S : Number(process.env["SMOKE_TIMEOUT_S"]);
if (!Number.isInteger(timeoutS) || timeoutS < 1) usage("SMOKE_TIMEOUT_S must be a positive integer");

const url = `wss://${host}/ws`;
const origin = `https://${host}`;
const channel = `#smoke${String(Date.now() % 100000).padStart(5, "0")}`;
const t0 = Date.now();

/** Text that may come from the server or the agent: no colour codes, no control characters, no secret, short. */
const clean = (text) =>
  String(text)
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .split(secret)
    .join("<redacted>")
    .slice(0, MAX_PRINTED);
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;
const step = (text) => {
  console.log(`${stamp()} ${clean(text)}`);
};

/** Node's global WebSocket sends the Origin header; if it is missing, use the ws package of apps/ircd. */
function openSocket() {
  if (typeof WebSocket === "function") {
    try {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      return {
        send: (text) => ws.send(text),
        close: () => ws.close(),
        buffered: () => ws.bufferedAmount,
        onOpen: (fn) => ws.addEventListener("open", () => fn()),
        onMessage: (fn) => ws.addEventListener("message", (e) => fn(String(e.data))),
        onClose: (fn) => ws.addEventListener("close", () => fn()),
        onError: (fn) => ws.addEventListener("error", () => fn("connection error")),
      };
    } catch {
      // Fall through to the ws package.
    }
  }
  const require = createRequire(new URL("../apps/ircd/package.json", import.meta.url));
  const { WebSocket: Ws } = require("ws");
  const ws = new Ws(url, { headers: { Origin: origin } });
  return {
    send: (text) => ws.send(text),
    close: () => ws.close(),
    buffered: () => ws.bufferedAmount,
    onOpen: (fn) => ws.on("open", () => fn()),
    onMessage: (fn) => ws.on("message", (data) => fn(data.toString())),
    onClose: (fn) => ws.on("close", () => fn()),
    onError: (fn) => ws.on("error", (err) => fn(err.message)),
  };
}

const socket = openSocket();
let invited = false;
let kicked = false;
let finished = false;
// promptScheduled: the prompt is queued behind the delay. promptDelivered: it was actually sent;
// only then can an agent PRIVMSG be its reply.
const seen = { worktreeReady: false, agentJoined: false, promptScheduled: false, promptDelivered: false };

const send = (line) => {
  try {
    socket.send(`${line}\r\n`);
  } catch {
    // The socket is already gone; the close handler reports it.
  }
};

/** Exits once the socket has flushed what was queued (KICK, QUIT), or after FLUSH_WAIT_MS at the latest. */
const end = (code) => {
  if (finished) return;
  finished = true;
  const deadline = Date.now() + FLUSH_WAIT_MS;
  const poll = () => {
    let pending = 0;
    try {
      pending = socket.buffered();
    } catch {
      pending = 0;
    }
    if (pending > 0 && Date.now() < deadline) {
      setTimeout(poll, 20);
      return;
    }
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    process.exit(code);
  };
  poll();
};

const kick = () => {
  if (kicked) return;
  kicked = true;
  send(`KICK ${channel} ${agent} :smoke done`);
};

const fail = (reason) => {
  if (finished) return;
  console.error(`${stamp()} FAIL: ${clean(reason)}`);
  // No agent session may be left running after a failed run, even when it has not joined yet.
  if (invited) kick();
  end(1);
};

const succeed = () => {
  send("QUIT :smoke done");
  end(0);
};

const timer = setTimeout(() => fail(`timeout after ${timeoutS} s`), timeoutS * 1000);
timer.unref();
process.on("SIGINT", () => fail("interrupted"));
process.on("SIGTERM", () => fail("interrupted"));

const maybeStartPrompt = () => {
  if (seen.promptScheduled || !seen.worktreeReady || !seen.agentJoined) return;
  seen.promptScheduled = true;
  send(`MODE ${channel} +v ${agent}`);
  setTimeout(() => {
    // The run may have failed or kicked the agent during the delay: then no prompt is sent.
    if (finished || kicked) return;
    send(`PRIVMSG ${channel} :${agent} ${PROMPT}`);
    seen.promptDelivered = true;
    step("prompt sent");
  }, PROMPT_DELAY_MS);
};

const lower = (text) => text.toLowerCase();

const onLine = (line) => {
  if (finished) return;
  const ping = /^PING\s+:?(.*)$/i.exec(line);
  if (ping !== null) {
    send(`PONG :${ping[1] ?? ""}`);
    return;
  }
  if (/^ERROR\b/i.test(line)) {
    fail(`server sent ERROR (${line})`);
    return;
  }
  const numeric = /^:\S+ (\d{3}) \S+ ?(.*)$/.exec(line);
  const code = numeric?.[1];
  if (code === "001") {
    step(`registered as ${nick}`);
    send(`JOIN ${channel}`);
  } else if (code === "366" && !invited) {
    step(`joined ${channel}`);
    invited = true;
    send(`INVITE ${agent} ${channel}`);
  } else if (code === "433" || code === "464" || code === "465") {
    fail(`login refused (numeric ${code}): check the nick and SMOKE_SECRET`);
  } else if (code !== undefined && JOIN_ERRORS.has(code) && !invited) {
    fail(`cannot join ${channel} (numeric ${code}: ${numeric?.[2] ?? ""})`);
  } else if (code !== undefined && INVITE_ERRORS.has(code) && invited) {
    fail(`invite of ${agent} refused (numeric ${code}: ${numeric?.[2] ?? ""})`);
  }
  if (finished) return;

  const notice = /^:(\S+) NOTICE (\S+) :(.*)$/.exec(line);
  if (notice !== null) {
    const text = notice[3] ?? "";
    if (lower(text).includes("could not start")) {
      fail(`agent could not start: ${text}`);
    } else if (lower(text).includes("worktree ready") && !seen.worktreeReady) {
      seen.worktreeReady = true;
      step("worktree ready");
      maybeStartPrompt();
    } else if (lower(text).includes("still waking up")) {
      // agent-runner Requirement 3.21: the prompt arrived before the Session was ready and is queued
      // (or, when the queue is full, refused); the reply follows once session/new completes.
      step(`agent: ${text}`);
    } else if (lower(text).includes("queued message") && lower(text).includes("dropped")) {
      fail(`queued prompt dropped: ${text}`);
    } else if (lower(clean(text).trim()) === `${lower(agent)} is ready`) {
      step(`${agent} is ready`);
    } else if (kicked && lower(text).includes("credits used")) {
      step(`credits line: ${text}`);
      succeed();
    }
    return;
  }

  const prefixed = /^:([^!\s]+)![^\s]* (\S+) (\S+)(?: :?(.*))?$/.exec(line);
  if (prefixed === null) return;
  const [, who, command, target, rest = ""] = prefixed;
  const fromAgent = lower(who) === lower(agent);
  if (command === "JOIN" && fromAgent && lower(target.replace(/^:/, "")) === lower(channel) && !seen.agentJoined) {
    seen.agentJoined = true;
    step(`${agent} joined`);
    maybeStartPrompt();
  } else if (command === "PRIVMSG" && fromAgent && lower(target) === lower(channel) && seen.promptDelivered && !kicked) {
    // Only a line that arrives after the prompt went out is its reply.
    const text = clean(rest).trim();
    step(`reply: ${text}${/pong/i.test(text) ? " (PONG)" : " (no PONG in the first line)"}`);
    kick();
    step("kick sent");
  } else if (command === "KICK" && lower(who) === lower(nick) && lower(target) === lower(channel)) {
    step("kick ok");
  }
};

let partial = "";
socket.onMessage((data) => {
  partial += data;
  const lines = partial.split(/\r?\n/);
  partial = lines.pop() ?? "";
  for (const line of lines) if (line !== "") onLine(line);
  if (partial.length > MAX_PARTIAL) fail("server line too long");
});
// An error leaves the socket possibly open: fail() kicks the agent first when it was invited.
socket.onError((reason) => {
  fail(`socket error (${reason})`);
});
socket.onClose(() => {
  if (finished) return;
  // Nothing can be sent on a closed socket, so there is nobody to kick.
  finished = true;
  console.error(`${stamp()} FAIL: socket closed before the smoke test finished`);
  process.exit(1);
});
// The credentials go out as the first lines once the socket is open; the PASS line is never printed.
socket.onOpen(() => {
  step("connected");
  send(`PASS ${nick}:${secret}`);
  send(`NICK ${nick}`);
  send("USER smoke 0 * :Seance smoke test");
});
step(`connecting to ${url}`);
