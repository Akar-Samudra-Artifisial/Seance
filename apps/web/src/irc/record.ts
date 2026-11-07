// Null-prototype records keyed by untrusted strings (nicks, channel names).
// Keys like "constructor", "toString" or "__proto__" are ordinary own keys here.

export type Rec<T> = Readonly<Record<string, T>>;

/** A fresh empty record without a prototype. */
export function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Own-key lookup; never reads inherited properties. */
export function getOwn<T>(rec: Rec<T> | undefined, key: string): T | undefined {
  return rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

export function hasOwnKey(rec: Rec<unknown> | undefined, key: string): boolean {
  return rec !== undefined && Object.hasOwn(rec, key);
}

/** Copy of `rec` with `key` set. */
export function withEntry<T>(rec: Rec<T> | undefined, key: string, value: T): Rec<T> {
  const next = nullRecord<T>();
  if (rec !== undefined) for (const k of Object.keys(rec)) next[k] = rec[k] as T;
  next[key] = value;
  return next;
}

/** Copy of `rec` without `key`; the input itself when the key is absent. */
export function withoutEntry<T>(rec: Rec<T>, key: string): Rec<T> {
  if (!Object.hasOwn(rec, key)) return rec;
  const next = nullRecord<T>();
  for (const k of Object.keys(rec)) if (k !== key) next[k] = rec[k] as T;
  return next;
}

/** Copy of `rec` (null-prototype). */
export function copyRec<T>(rec: Rec<T> | undefined): Record<string, T> {
  const next = nullRecord<T>();
  if (rec !== undefined) for (const k of Object.keys(rec)) next[k] = rec[k] as T;
  return next;
}
