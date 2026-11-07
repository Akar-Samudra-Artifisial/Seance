import { describe, expect, it } from "vitest";
import { ConfigError, loadRunnerConfig } from "../src/config.js";
import type { EnvSource } from "../src/config.js";

const BASE: Record<string, string> = {
  SEANCE_TARGET_REPO: "/repo",
  SEANCE_WORKSPACES: "/ws",
};

function load(extra: EnvSource = {}, base: EnvSource = BASE) {
  return loadRunnerConfig({ ...base, ...extra }, "/cwd");
}

function errorOf(env: EnvSource): ConfigError {
  try {
    loadRunnerConfig(env, "/cwd");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected loadRunnerConfig to throw");
}

describe("loadRunnerConfig defaults", () => {
  it("applies defaults when optional variables are unset", () => {
    expect(load()).toEqual({
      harness: "acp",
      kiroBin: "kiro-cli",
      kiroApiKey: undefined,
      targetRepo: "/repo",
      workspaces: "/ws",
      agentsDir: "/cwd/agents",
      promptTimeoutMs: 120_000,
      channelCreditCap: undefined,
      inviteRate: 5,
      inviters: undefined,
    });
  });

  it("treats empty optional variables like unset", () => {
    const cfg = load({
      SEANCE_HARNESS: "",
      SEANCE_KIRO_BIN: "",
      SEANCE_AGENTS_DIR: "",
      SEANCE_PROMPT_TIMEOUT_MS: "",
      SEANCE_CHANNEL_CREDIT_CAP: "",
      SEANCE_INVITE_RATE: "",
      SEANCE_INVITERS: "",
      KIRO_API_KEY: "",
    });
    expect(cfg.harness).toBe("acp");
    expect(cfg.kiroBin).toBe("kiro-cli");
    expect(cfg.agentsDir).toBe("/cwd/agents");
    expect(cfg.promptTimeoutMs).toBe(120_000);
    expect(cfg.channelCreditCap).toBeUndefined();
    expect(cfg.inviteRate).toBe(5);
    expect(cfg.inviters).toBeUndefined();
    expect(cfg.kiroApiKey).toBeUndefined();
  });
});

describe("loadRunnerConfig valid values", () => {
  it("accepts every variable with a valid value", () => {
    const cfg = load({
      SEANCE_HARNESS: "headless",
      SEANCE_KIRO_BIN: "/opt/fake-kiro",
      KIRO_API_KEY: "k-123",
      SEANCE_AGENTS_DIR: "/custom/agents",
      SEANCE_PROMPT_TIMEOUT_MS: "5000",
      SEANCE_CHANNEL_CREDIT_CAP: "2.5",
      SEANCE_INVITE_RATE: "10",
      SEANCE_INVITERS: "alice",
    });
    expect(cfg).toEqual({
      harness: "headless",
      kiroBin: "/opt/fake-kiro",
      kiroApiKey: "k-123",
      targetRepo: "/repo",
      workspaces: "/ws",
      agentsDir: "/custom/agents",
      promptTimeoutMs: 5000,
      channelCreditCap: 2.5,
      inviteRate: 10,
      inviters: ["alice"],
    });
  });

  it("accepts harness acp explicitly", () => {
    expect(load({ SEANCE_HARNESS: "acp" }).harness).toBe("acp");
  });
});

describe("required variables", () => {
  it.each(["SEANCE_TARGET_REPO", "SEANCE_WORKSPACES"])("%s unset is rejected by name", (name) => {
    const { [name]: _omitted, ...rest } = BASE;
    const err = errorOf(rest);
    expect(err.variable).toBe(name);
    expect(err.message).toContain(name);
  });

  it.each(["SEANCE_TARGET_REPO", "SEANCE_WORKSPACES"])("%s empty is rejected by name", (name) => {
    const err = errorOf({ ...BASE, [name]: "" });
    expect(err.variable).toBe(name);
  });

  it.each(["SEANCE_TARGET_REPO", "SEANCE_WORKSPACES", "SEANCE_KIRO_BIN", "SEANCE_AGENTS_DIR"])(
    "%s blank is rejected with the value",
    (name) => {
      const err = errorOf({ ...BASE, [name]: "   " });
      expect(err.variable).toBe(name);
      expect(err.message).toContain(name);
      expect(err.message).toContain(JSON.stringify("   "));
    },
  );
});

describe("invalid values name the variable and the value", () => {
  it("SEANCE_HARNESS names both accepted values", () => {
    const err = errorOf({ ...BASE, SEANCE_HARNESS: "bogus" });
    expect(err.variable).toBe("SEANCE_HARNESS");
    expect(err.message).toContain("SEANCE_HARNESS");
    expect(err.message).toContain("bogus");
    expect(err.message).toContain("acp");
    expect(err.message).toContain("headless");
  });

  it.each(["0", "-1", "1.5", "abc", "1e3", "99999999999999999999"])(
    "SEANCE_PROMPT_TIMEOUT_MS rejects %s",
    (value) => {
      const err = errorOf({ ...BASE, SEANCE_PROMPT_TIMEOUT_MS: value });
      expect(err.variable).toBe("SEANCE_PROMPT_TIMEOUT_MS");
      expect(err.message).toContain(JSON.stringify(value));
    },
  );

  it.each(["0", "-3", "2.5", "five", " ", "1e1"])("SEANCE_INVITE_RATE rejects %s", (value) => {
    // " " is non-empty but not a positive integer.
    const err = errorOf({ ...BASE, SEANCE_INVITE_RATE: value });
    expect(err.variable).toBe("SEANCE_INVITE_RATE");
    expect(err.message).toContain("SEANCE_INVITE_RATE");
    expect(err.message).toContain(JSON.stringify(value));
  });

  it.each(["0", "-1", "abc", "Infinity", "NaN", " "])(
    "SEANCE_CHANNEL_CREDIT_CAP rejects %s",
    (value) => {
      const err = errorOf({ ...BASE, SEANCE_CHANNEL_CREDIT_CAP: value });
      expect(err.variable).toBe("SEANCE_CHANNEL_CREDIT_CAP");
      expect(err.message).toContain(JSON.stringify(value));
    },
  );

  it("SEANCE_CHANNEL_CREDIT_CAP accepts a fractional cap", () => {
    expect(load({ SEANCE_CHANNEL_CREDIT_CAP: "0.5" }).channelCreditCap).toBe(0.5);
  });

  it("trims surrounding whitespace on numeric values", () => {
    expect(load({ SEANCE_INVITE_RATE: " 7 " }).inviteRate).toBe(7);
    expect(load({ SEANCE_PROMPT_TIMEOUT_MS: " 250 " }).promptTimeoutMs).toBe(250);
  });
});

describe("SEANCE_INVITERS", () => {
  it("trims entries", () => {
    expect(load({ SEANCE_INVITERS: " alice , bob,carol " }).inviters).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("treats an all-whitespace value as unset", () => {
    expect(load({ SEANCE_INVITERS: "   " }).inviters).toBeUndefined();
  });

  it("rejects an invalid entry, naming the variable and the entry", () => {
    const err = errorOf({ ...BASE, SEANCE_INVITERS: "alice, bad nick ,bob" });
    expect(err.variable).toBe("SEANCE_INVITERS");
    expect(err.message).toContain("SEANCE_INVITERS");
    expect(err.message).toContain(JSON.stringify("bad nick"));
  });

  it("rejects an empty entry between commas", () => {
    const err = errorOf({ ...BASE, SEANCE_INVITERS: "alice,,bob" });
    expect(err.variable).toBe("SEANCE_INVITERS");
    expect(err.message).toContain(JSON.stringify(""));
  });

  it("rejects an entry starting with a digit", () => {
    const err = errorOf({ ...BASE, SEANCE_INVITERS: "9lives" });
    expect(err.message).toContain(JSON.stringify("9lives"));
  });
});

describe("KIRO_API_KEY", () => {
  const SECRET = "sk-super-secret-value-42";

  it("is carried in the config when set", () => {
    expect(load({ KIRO_API_KEY: SECRET }).kiroApiKey).toBe(SECRET);
  });

  it("is absent when unset or empty", () => {
    expect(load().kiroApiKey).toBeUndefined();
    expect(load({ KIRO_API_KEY: "" }).kiroApiKey).toBeUndefined();
  });

  it.each([
    { SEANCE_HARNESS: "bogus" },
    { SEANCE_PROMPT_TIMEOUT_MS: "0" },
    { SEANCE_CHANNEL_CREDIT_CAP: "-1" },
    { SEANCE_INVITE_RATE: "x" },
    { SEANCE_INVITERS: "bad nick" },
    { SEANCE_KIRO_BIN: " " },
    { SEANCE_AGENTS_DIR: " " },
    { SEANCE_TARGET_REPO: "" },
    { SEANCE_WORKSPACES: "" },
  ])("never appears in the error for %j", (bad) => {
    const err = errorOf({ ...BASE, ...bad, KIRO_API_KEY: SECRET });
    expect(err.message).not.toContain(SECRET);
    expect(String(err.stack)).not.toContain(SECRET);
    expect(err.variable).not.toContain(SECRET);
  });
});
