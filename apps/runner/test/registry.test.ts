import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LogFields, RunnerLogger } from "../src/log.js";
import { AgentRegistry, NoAgentProfileError } from "../src/registry/agent-registry.js";

const repoAgents = resolve(dirname(fileURLToPath(import.meta.url)), "../../../agents");

interface LogEntry {
  readonly msg: string;
  readonly fields: LogFields | undefined;
}

const recordingLogger = (): { readonly log: RunnerLogger; readonly errors: LogEntry[] } => {
  const errors: LogEntry[] = [];
  const noop = (): void => undefined;
  return {
    errors,
    log: {
      debug: noop,
      info: noop,
      warn: noop,
      error: (msg, fields) => {
        errors.push({ msg, fields });
      },
    },
  };
};

const valid = (nick: string): Record<string, unknown> => ({
  nick,
  kiroAgent: nick,
  model: "claude-haiku-5.5",
  tools: "read",
  color: 3,
});

const withDir = async (
  files: Readonly<Record<string, string>>,
  fn: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "seance-registry-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("AgentRegistry", () => {
  it("loads exactly coder, reviewer and researcher from the committed agents/", async () => {
    const { log, errors } = recordingLogger();
    const registry = await AgentRegistry.load(repoAgents, log);
    expect(registry.all().map((p) => p.nick).sort()).toEqual(["coder", "researcher", "reviewer"]);
    expect(errors).toEqual([]);
  });

  it("looks nicks up with IRC case mapping", async () => {
    const registry = await AgentRegistry.load(repoAgents, recordingLogger().log);
    expect(registry.lookup("CODER")?.nick).toBe("coder");
    expect(registry.lookup("Reviewer")?.nick).toBe("reviewer");
    expect(registry.lookup("nobody")).toBeUndefined();
  });

  it("skips each kind of invalid file with an error naming the file and field", async () => {
    const files: Record<string, string> = {
      "a-ok.json": JSON.stringify(valid("okay")),
      "b-badjson.json": "{ not json",
      "c-missing.json": JSON.stringify({ ...valid("missing"), model: undefined }),
      "d-wrongtype.json": JSON.stringify({ ...valid("wrongtype"), tools: 5 }),
      "e-color.json": JSON.stringify({ ...valid("color"), color: 16 }),
      "f-nick.json": JSON.stringify({ ...valid("bad nick"), nick: "bad nick" }),
    };
    await withDir(files, async (dir) => {
      const { log, errors } = recordingLogger();
      const registry = await AgentRegistry.load(dir, log);
      expect(registry.all().map((p) => p.nick)).toEqual(["okay"]);
      expect(errors).toHaveLength(5);
      const expected: readonly (readonly [string, string])[] = [
        ["b-badjson.json", "(json)"],
        ["c-missing.json", "model"],
        ["d-wrongtype.json", "tools"],
        ["e-color.json", "color"],
        ["f-nick.json", "nick"],
      ];
      for (const [file, field] of expected) {
        const entry = errors.find((e) => e.fields?.["file"] === join(dir, file));
        expect(entry, file).toBeDefined();
        expect(entry?.fields?.["field"]).toBe(field);
        expect(entry?.msg).toContain(file);
      }
    });
  });

  it("rejects a profile that uses a service nick and keeps loading the others (runner-services Req 1.4)", async () => {
    const files: Record<string, string> = {
      "a-ok.json": JSON.stringify(valid("okay")),
      "b-chanserv.json": JSON.stringify({ ...valid("x"), nick: "chanserv" }),
      "c-nickserv.json": JSON.stringify({ ...valid("y"), nick: "NickServ" }),
    };
    await withDir(files, async (dir) => {
      const { log, errors } = recordingLogger();
      const registry = await AgentRegistry.load(dir, log);
      expect(registry.all().map((p) => p.nick)).toEqual(["okay"]);
      expect(errors).toHaveLength(2);
      for (const file of ["b-chanserv.json", "c-nickserv.json"]) {
        const entry = errors.find((e) => e.fields?.["file"] === join(dir, file));
        expect(entry?.fields?.["field"]).toBe("nick");
        expect(entry?.msg).toContain("reserved for network services");
      }
    });
  });

  it("keeps the first profile when a nick is duplicated (case-mapped)", async () => {
    await withDir(
      {
        "a.json": JSON.stringify(valid("Dup")),
        "b.json": JSON.stringify(valid("dup")),
      },
      async (dir) => {
        const { log, errors } = recordingLogger();
        const registry = await AgentRegistry.load(dir, log);
        expect(registry.all()).toHaveLength(1);
        expect(registry.lookup("DUP")?.file).toBe(join(dir, "a.json"));
        expect(errors).toHaveLength(1);
        expect(errors[0]?.msg).toContain(join(dir, "b.json"));
        expect(errors[0]?.msg).toContain(join(dir, "a.json"));
      },
    );
  });

  it("throws NoAgentProfileError when no profile is valid", async () => {
    await withDir({ "bad.json": "nope" }, async (dir) => {
      const { log, errors } = recordingLogger();
      await expect(AgentRegistry.load(dir, log)).rejects.toBeInstanceOf(NoAgentProfileError);
      expect(errors).toHaveLength(1);
    });
    await withDir({}, async (dir) => {
      await expect(AgentRegistry.load(dir, recordingLogger().log)).rejects.toBeInstanceOf(
        NoAgentProfileError,
      );
    });
  });

  it("never reads .kiro/agents or other subdirectories", async () => {
    await withDir(
      {
        "top.json": JSON.stringify(valid("top")),
        ".kiro/agents/hidden.json": JSON.stringify(valid("hidden")),
        "sub/nested.json": JSON.stringify(valid("nested")),
      },
      async (dir) => {
        const { log, errors } = recordingLogger();
        const registry = await AgentRegistry.load(dir, log);
        expect(registry.all().map((p) => p.nick)).toEqual(["top"]);
        expect(registry.lookup("hidden")).toBeUndefined();
        expect(errors).toEqual([]);
      },
    );
    await withDir({ ".kiro/agents/only.json": JSON.stringify(valid("only")) }, async (dir) => {
      await expect(AgentRegistry.load(dir, recordingLogger().log)).rejects.toBeInstanceOf(
        NoAgentProfileError,
      );
    });
  });
});

describe("kiroAgent in podman mode (agent-sandbox Requirement 4.5)", () => {
  const silent: RunnerLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

  it("accepts flag-safe names and skips the others only when sandboxed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-reg-sbx-"));
    try {
      const profile = (nick: string, kiroAgent: string): string => JSON.stringify({ nick, kiroAgent, model: "m", tools: "t", color: 1 });
      await writeFile(join(dir, "a.json"), profile("good", "coder.v2_x-1"));
      await writeFile(join(dir, "b.json"), profile("dash", "-rf"));
      await writeFile(join(dir, "c.json"), profile("spaced", "my agent"));
      const plain = await AgentRegistry.load(dir, silent);
      expect(plain.all().map((p) => p.nick)).toEqual(["good", "dash", "spaced"]);
      const sandboxed = await AgentRegistry.load(dir, silent, { sandboxed: true });
      expect(sandboxed.all().map((p) => p.nick)).toEqual(["good"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the repository's agents pass the podman rule", async () => {
    const reg = await AgentRegistry.load(repoAgents, silent, { sandboxed: true });
    expect(reg.all().length).toBeGreaterThan(0);
  });
});
