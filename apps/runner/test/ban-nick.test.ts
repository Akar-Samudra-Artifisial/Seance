// Audit 10.11: which ircd ban masks (`MODE +b`) the runner mirrors into its Ban_List.
import { describe, expect, it } from "vitest";
import { banNickOf } from "../src/runner.js";

describe("banNickOf", () => {
  it.each([
    ["coder", "coder"],
    ["coder!*@*", "coder"],
    ["Coder!**@**", "Coder"],
  ])("%s names the nick %s", (mask, nick) => {
    expect(banNickOf(mask)).toBe(nick);
  });

  it.each(["", "co*!*@*", "c?der!*@*", "coder!bot@*", "coder!*@evil.example", "*!*@*", "!*@*"])(
    "%j names no single nick, so it stays with the ircd",
    (mask) => {
      expect(banNickOf(mask)).toBeUndefined();
    },
  );
});
