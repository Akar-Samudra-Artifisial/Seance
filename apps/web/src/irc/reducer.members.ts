import { keyOf } from "./casemap.js";
import { copyRec, getOwn, hasOwnKey, nullRecord, withEntry, withoutEntry } from "./record.js";
import type { Member } from "./types.js";

/** Parse the trailing parameter of a 353 reply. `@` marks an op, `+` a voiced user. */
export function parseNames(text: string): readonly Member[] {
  const out: Member[] = [];
  for (const raw of text.split(" ")) {
    let op = false;
    let voice = false;
    let i = 0;
    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "@") op = true;
      else if (ch === "+") voice = true;
      else break;
    }
    const nick = raw.slice(i);
    if (nick.length > 0) out.push({ nick, op, voice });
  }
  return out;
}

type MemberSet = Readonly<Record<string, Member>>;

const empty = (): MemberSet => nullRecord<Member>();

/** True when `nick` is in the set under rfc1459 case-mapping. */
export function hasMember(members: MemberSet | undefined, nick: string): boolean {
  return hasOwnKey(members, keyOf(nick));
}

/** Add a member with no flags when absent; an existing entry is kept as is. */
export function addMember(members: MemberSet | undefined, nick: string): MemberSet {
  if (hasMember(members, nick)) return members ?? empty();
  return withEntry(members, keyOf(nick), { nick, op: false, voice: false });
}

/** Remove a member. Returns the input set when the nick is absent. */
export function removeMember(members: MemberSet | undefined, nick: string): MemberSet {
  if (!hasMember(members, nick)) return members ?? empty();
  return withoutEntry(members ?? empty(), keyOf(nick));
}

/**
 * Rename a member, keeping its flags. When the new nick already exists the
 * renamed entry replaces it, so the set keeps exactly one entry.
 */
export function renameMember(members: MemberSet | undefined, from: string, to: string): MemberSet {
  const old = getOwn(members, keyOf(from));
  if (members === undefined || old === undefined) return members ?? empty();
  const rest = removeMember(members, from);
  return withEntry(rest, keyOf(to), { nick: to, op: old.op, voice: old.voice });
}

/** Set or clear a flag. Ignored (same set returned) when the nick is not a member. */
export function setFlag(
  members: MemberSet | undefined,
  nick: string,
  flag: "op" | "voice",
  value: boolean,
): MemberSet {
  const cur = getOwn(members, keyOf(nick));
  if (members === undefined || cur === undefined) return members ?? empty();
  return withEntry(members, keyOf(nick), { ...cur, [flag]: value });
}

/** Modes that take a parameter in both directions; `l` only when set. */
const ARG_BOTH = new Set(["b", "k", "e", "I"]);

/**
 * Apply a channel MODE (`modes` plus its arguments) to a member set. Only
 * `±o` and `±v` change anything; other modes just consume their arguments.
 */
export function applyModes(members: MemberSet | undefined, modes: string, args: readonly string[]): MemberSet {
  let next: MemberSet = members ?? empty();
  let adding = true;
  let argIdx = 0;
  for (const ch of modes) {
    if (ch === "+") adding = true;
    else if (ch === "-") adding = false;
    else if (ch === "o" || ch === "v") {
      const target = args[argIdx++];
      if (target !== undefined) next = setFlag(next, target, ch === "o" ? "op" : "voice", adding);
    } else if (ARG_BOTH.has(ch) || (ch === "l" && adding)) argIdx++;
  }
  return next;
}

/** Merge members into a set keyed by irc_lower(nick). Returns a new record. */
export function mergeMembers(
  current: Readonly<Record<string, Member>> | undefined,
  add: readonly Member[],
): Readonly<Record<string, Member>> {
  const next = copyRec<Member>(current);
  for (const m of add) next[keyOf(m.nick)] = m;
  return next;
}
