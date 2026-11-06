import { describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channel-registry.js";

describe("ChannelRegistry create/delete (Req 5.1, 5.8)", () => {
  it("creates the channel on first join and makes the creator +o", () => {
    const reg = new ChannelRegistry();
    const result = reg.join("a", "#Test");
    expect(result.kind).toBe("created");
    expect(result.channel.name).toBe("#Test");
    expect(result.channel.members.get("a")).toEqual({ op: true, voice: false });
    expect(reg.isOp("#Test", "a")).toBe(true);
  });

  it("gives later joiners no status", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#t");
    expect(reg.join("b", "#t").kind).toBe("joined");
    expect(reg.get("#t")?.members.get("b")).toEqual({ op: false, voice: false });
    expect(reg.isOp("#t", "b")).toBe(false);
  });

  it("looks channels up with rfc1459 case-mapping", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#Foo[x]");
    expect(reg.has("#foo{X}")).toBe(true);
    expect(reg.join("b", "#FOO{x}").kind).toBe("joined");
    expect(reg.list()).toHaveLength(1);
  });

  it("reports already-member without changing state", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#t");
    expect(reg.join("a", "#t").kind).toBe("already-member");
    expect(reg.isOp("#t", "a")).toBe(true);
  });

  it("throws on an invalid channel name", () => {
    expect(() => new ChannelRegistry().join("a", "nochan")).toThrow(/not a valid channel/);
  });

  it("deletes the channel when the last member parts, discarding state", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#t");
    reg.join("b", "#t");
    const channel = reg.get("#t");
    if (channel === undefined) throw new Error("channel missing");
    channel.topic = "hello";
    channel.modes.moderated = true;
    expect(reg.part("a", "#t")).toBe(true);
    expect(reg.has("#t")).toBe(true);
    expect(reg.part("b", "#t")).toBe(true);
    expect(reg.has("#t")).toBe(false);
    const again = reg.join("c", "#t");
    expect(again.kind).toBe("created");
    expect(again.channel.topic).toBeUndefined();
    expect(again.channel.modes.moderated).toBe(false);
  });

  it("part returns false for unknown channel or non-member", () => {
    const reg = new ChannelRegistry();
    expect(reg.part("a", "#none")).toBe(false);
    reg.join("a", "#t");
    expect(reg.part("b", "#t")).toBe(false);
    expect(reg.has("#t")).toBe(true);
  });

  it("removeClient leaves every channel and deletes emptied ones", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#one");
    reg.join("a", "#two");
    reg.join("b", "#two");
    const affected = reg.removeClient("a");
    expect(affected.map((c) => c.name).sort()).toEqual(["#one", "#two"]);
    expect(reg.has("#one")).toBe(false);
    expect(reg.has("#two")).toBe(true);
    expect(reg.channelsOf("a")).toHaveLength(0);
  });
});

describe("ChannelRegistry permission helpers (Req 5.1, 6.6)", () => {
  it("isOp is false for non-members and unknown channels", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#t");
    expect(reg.isOp("#t", "ghost")).toBe(false);
    expect(reg.isOp("#none", "a")).toBe(false);
  });

  it("canSpeak lets every member speak without +m", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#t");
    reg.join("b", "#t");
    expect(reg.canSpeak("#t", "b")).toBe(true);
  });

  it("canSpeak is false for non-members even without +m", () => {
    const reg = new ChannelRegistry();
    reg.join("a", "#t");
    expect(reg.canSpeak("#t", "ghost")).toBe(false);
    expect(reg.canSpeak("#none", "a")).toBe(false);
  });

  it("under +m only +o or +v members can speak", () => {
    const reg = new ChannelRegistry();
    reg.join("op", "#t");
    reg.join("voiced", "#t");
    reg.join("plain", "#t");
    const channel = reg.get("#t");
    if (channel === undefined) throw new Error("channel missing");
    channel.modes.moderated = true;
    const voiced = channel.members.get("voiced");
    if (voiced === undefined) throw new Error("member missing");
    voiced.voice = true;
    expect(reg.canSpeak("#t", "op")).toBe(true);
    expect(reg.canSpeak("#t", "voiced")).toBe(true);
    expect(reg.canSpeak("#t", "plain")).toBe(false);
    channel.modes.moderated = false;
    expect(reg.canSpeak("#t", "plain")).toBe(true);
  });
});
