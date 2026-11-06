import { describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channel-registry.js";

function setup(): ChannelRegistry {
  const reg = new ChannelRegistry();
  reg.join("op", "#t", "op");
  return reg;
}

describe("ChannelRegistry invite records (Req 7)", () => {
  it("records an invite under the channel's invited set (7.1)", () => {
    const reg = setup();
    expect(reg.invite("#t", "Coder")).toBe(true);
    expect(reg.isInvited("#t", "coder")).toBe(true);
    expect(reg.get("#t")?.invited.size).toBe(1);
  });

  it("returns false and records nothing for a missing channel", () => {
    const reg = new ChannelRegistry();
    expect(reg.invite("#nope", "coder")).toBe(false);
    expect(reg.isInvited("#nope", "coder")).toBe(false);
  });

  it("clears the invite when the invited nick joins (7.2)", () => {
    const reg = setup();
    reg.invite("#t", "coder");
    expect(reg.join("c1", "#t", "Coder").kind).toBe("joined");
    expect(reg.isInvited("#t", "coder")).toBe(false);
    expect(reg.get("#t")?.invited.size).toBe(0);
  });

  it("discards the invited set when the last member leaves (7.3) and starts empty on recreation (7.8)", () => {
    const reg = setup();
    reg.invite("#t", "coder");
    const old = reg.get("#t");
    expect(reg.part("op", "#t")).toBe(true);
    expect(reg.has("#t")).toBe(false);
    expect(reg.isInvited("#t", "coder")).toBe(false);

    const result = reg.join("op2", "#t", "op2");
    expect(result.kind).toBe("created");
    expect(result.channel.invited.size).toBe(0);
    expect(result.channel).not.toBe(old);
    expect(reg.isInvited("#t", "coder")).toBe(false);
  });

  it("discards invites when the last member is removed by removeClient (7.3)", () => {
    const reg = setup();
    reg.invite("#t", "coder");
    reg.removeClient("op");
    expect(reg.join("op2", "#t", "op2").channel.invited.size).toBe(0);
  });

  it("keeps a single entry when the same nick is invited twice (7.4)", () => {
    const reg = setup();
    reg.invite("#t", "coder");
    reg.invite("#t", "coder");
    expect(reg.get("#t")?.invited.size).toBe(1);
  });

  it("does not gate joins on invite records (7.5)", () => {
    const reg = setup();
    reg.invite("#t", "coder");
    expect(reg.join("stranger", "#t", "stranger").kind).toBe("joined");
    expect(reg.join("coder-id", "#t", "coder").kind).toBe("joined");
    expect(reg.isMember("#t", "stranger")).toBe(true);
    expect(reg.isMember("#t", "coder-id")).toBe(true);
  });

  it("shares one entry across case and rfc1459 variants (7.6)", () => {
    const reg = setup();
    reg.invite("#t", "Bot[1]");
    reg.invite("#t", "bot{1}");
    reg.invite("#t", "BOT{1}");
    const invited = reg.get("#t")?.invited;
    expect(invited?.size).toBe(1);
    expect(reg.isInvited("#t", "BOT[1]")).toBe(true);
  });

  it("leaves the invited set unchanged when a non-invited nick joins (7.7)", () => {
    const reg = setup();
    reg.invite("#t", "coder");
    const before = [...(reg.get("#t")?.invited ?? [])];
    reg.join("other", "#t", "other");
    expect([...(reg.get("#t")?.invited ?? [])]).toEqual(before);
    expect(reg.isInvited("#t", "coder")).toBe(true);
  });
});
