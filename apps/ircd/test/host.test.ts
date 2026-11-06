import { describe, expect, it } from "vitest";
import { normalizeHost } from "../src/host.js";

const cases: ReadonlyArray<readonly [string, string | undefined, string | undefined]> = [
  ["plain IPv4 is unchanged (8.3)", "192.168.1.10", "192.168.1.10"],
  ["IPv4-mapped loopback becomes dotted-quad (8.1)", "::ffff:127.0.0.1", "127.0.0.1"],
  ["uppercase ::FFFF: prefix is matched case-insensitively (8.1)", "::FFFF:10.0.0.1", "10.0.0.1"],
  ["::1 gets a leading 0 (8.2)", "::1", "0::1"],
  ["full IPv6 is unchanged (8.3)", "2001:db8::1", "2001:db8::1"],
  ["link-local IPv6 is unchanged (8.3)", "fe80::1", "fe80::1"],
  ["mapped non-dotted-quad gets a leading 0 (8.2)", "::ffff:abcd:1234", "0::ffff:abcd:1234"],
  ["empty string stays empty (8.10)", "", ""],
  ["undefined stays undefined (8.11)", undefined, undefined],
];

describe("normalizeHost", () => {
  it.each(cases)("%s", (_name, input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
});
