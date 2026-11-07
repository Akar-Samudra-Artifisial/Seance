import { irc_lower } from "./casemap.js";
import type { Member } from "./types.js";

/** 0 = operator, 1 = voiced non-operator, 2 = others. */
function rank(m: Member): number {
  if (m.op) return 0;
  return m.voice ? 1 : 2;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Nick list order: operators, voiced, others; alphabetical by irc_lower(nick) within each. Returns a new array. */
export function sortMembers(members: readonly Member[]): Member[] {
  return members
    .map((m) => ({ m, key: irc_lower(m.nick) }))
    .sort((a, b) => rank(a.m) - rank(b.m) || compareKeys(a.key, b.key))
    .map((e) => e.m);
}

/** Nick list prefix: "@" for operators (wins over voice), "+" for voiced, "" otherwise. */
export function memberPrefix(member: Pick<Member, "op" | "voice">): "@" | "+" | "" {
  if (member.op) return "@";
  return member.voice ? "+" : "";
}
