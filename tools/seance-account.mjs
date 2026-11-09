#!/usr/bin/env node
// Creates one IRCD_ACCOUNTS_FILE line for a nick (public-hardening Requirement 2.6).
//
//   node tools/seance-account.mjs <nick> >> accounts.txt      # type the secret, then Enter
//   printf %s "$SECRET" | node tools/seance-account.mjs <nick> >> accounts.txt
//   chmod 600 accounts.txt
//
// The secret is read from stdin and never printed; only the scrypt hash is written to stdout. The
// format matches apps/ircd/src/accounts.ts: <nick>:scrypt$<N>$<r>$<p>$<salt b64>$<key b64>.
// Log in from an IRC client with PASS <nick>:<secret>. Keep accounts files out of the repository.
import { randomBytes, scryptSync } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const NICK = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,29}$/;
const MIN_SECRET = 12;

const nick = process.argv[2];
if (nick === undefined || !NICK.test(nick)) {
  console.error("usage: node tools/seance-account.mjs <nick>   (secret on stdin; nick: valid IRC nick, max 30)");
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
// One trailing newline from an interactive Enter is not part of the secret.
const secret = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (secret.length < MIN_SECRET) {
  console.error(`the secret must have at least ${MIN_SECRET} characters`);
  process.exit(2);
}
// A colon is fine: PASS <nick>:<secret> splits on the first one.
if (/\s/.test(secret)) {
  console.error("the secret must not contain whitespace (IRC PASS takes one parameter)");
  process.exit(2);
}

const salt = randomBytes(16);
const key = scryptSync(secret, salt, 32, { N, r: R, p: P, maxmem: 128 * N * R * P + 4 * 1024 * 1024 });
process.stdout.write(`${nick}:scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}\n`);
