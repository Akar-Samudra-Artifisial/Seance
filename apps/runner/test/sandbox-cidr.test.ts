// agent-sandbox review finding 4: SEANCE_SANDBOX_BLOCKED_CIDRS entries and the probe address in each.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isCidr, probeTargetIn } from "../src/sandbox/cidr.js";

describe("isCidr", () => {
  it.each(["10.0.0.0/16", "172.31.0.0/16", "192.168.1.0/24", "169.254.0.0/16", "10.1.2.3/32", "0.0.0.0/0"])("accepts %s", (c) => {
    expect(isCidr(c)).toBe(true);
  });
  it.each(["10.0.0.0", "10.0.0.0/33", "10.0.0.0/-1", "256.0.0.0/8", "10.0.0/8", "10.0.0.0/08x", "a.b.c.d/8", "10.0.0.0/8/8", "", "::1/128"])("rejects %j", (c) => {
    expect(isCidr(c)).toBe(false);
  });
});

describe("probeTargetIn", () => {
  it.each([
    ["10.0.0.0/16", "10.0.0.1:443"],
    ["172.31.0.0/16", "172.31.0.1:443"],
    ["192.168.1.0/24", "192.168.1.1:443"],
    ["10.1.2.3/32", "10.1.2.3:443"],
    ["10.1.2.2/31", "10.1.2.2:443"],
    ["10.1.2.77/24", "10.1.2.1:443"], // host bits in the entry are masked off
  ])("%s -> %s", (cidr, target) => {
    expect(probeTargetIn(cidr)).toBe(target);
  });

  it("P: the target lies inside its CIDR and is a valid probe target", () => {
    fc.assert(
      fc.property(fc.tuple(fc.nat({ max: 255 }), fc.nat({ max: 255 }), fc.nat({ max: 255 }), fc.nat({ max: 255 })), fc.integer({ min: 0, max: 32 }), (o, bits) => {
        const cidr = `${o.join(".")}/${bits}`;
        const target = probeTargetIn(cidr);
        const [ip, port] = target.split(":");
        expect(port).toBe("443");
        const n = (s: string): number => s.split(".").reduce((acc, p) => acc * 256 + Number(p), 0);
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        expect((n(ip ?? "") & mask) >>> 0).toBe((n(cidr.split("/")[0] ?? "") & mask) >>> 0);
      }),
      { numRuns: 200 },
    );
  });
});
