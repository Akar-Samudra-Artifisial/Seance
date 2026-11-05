import { describe, expect, it } from "vitest";
import type { IrcMessage } from "../src/index.js";

describe("IrcMessage", () => {
  it("can describe a PRIVMSG to a channel", () => {
    const message: IrcMessage = {
      prefix: "coder!coder@seance",
      command: "PRIVMSG",
      params: ["#fix-bug-123", "Plan: guard against a null email."],
    };

    expect(message.command).toBe("PRIVMSG");
    expect(message.params).toHaveLength(2);
  });
});
