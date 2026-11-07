// Review fixes: invisible/bidi characters are stripped and long topics are clipped in titles.
import { describe, expect, it } from "vitest";
import { formatIrc } from "./formatter.js";
import { initialState } from "./reducer.js";
import { nullRecord } from "./record.js";
import { TITLE_TOPIC_MAX, titleOf } from "./selectors.js";
import type { ClientState, Window } from "./types.js";

function withTopic(topic: string): ClientState {
  const base = initialState("alice");
  const win: Window = {
    key: "c:#dev",
    kind: "channel",
    name: "#dev",
    lines: [],
    unread: false,
    mentioned: false,
    modes: "",
    topic,
  };
  const windows = nullRecord<Window>();
  Object.assign(windows, base.windows, { [win.key]: win });
  return { ...base, windows, activeKey: win.key };
}

describe("formatter invisible characters", () => {
  it.each([
    ["U+200B", "\u200b"],
    ["U+200E", "\u200e"],
    ["U+200F", "\u200f"],
    ["U+061C", "\u061c"],
  ])("drops %s", (_name, ch) => {
    expect(formatIrc(`a${ch}b`).map((s) => s.text).join("")).toBe("ab");
  });
});

describe("titleOf topic length", () => {
  it("keeps a topic of exactly the limit unchanged", () => {
    const topic = "t".repeat(TITLE_TOPIC_MAX);
    expect(titleOf(withTopic(topic), "h")).toBe(`Séance — [#dev: ${topic}]`);
  });

  it("clips a longer topic to the limit with an ellipsis", () => {
    const t = titleOf(withTopic("t".repeat(500)), "h");
    expect(t).toBe(`Séance — [#dev: ${"t".repeat(TITLE_TOPIC_MAX - 1)}…]`);
  });

  it("counts code points, so an astral character is never split", () => {
    const t = titleOf(withTopic("👻".repeat(200)), "h");
    expect(t).toBe(`Séance — [#dev: ${"👻".repeat(TITLE_TOPIC_MAX - 1)}…]`);
  });
});
