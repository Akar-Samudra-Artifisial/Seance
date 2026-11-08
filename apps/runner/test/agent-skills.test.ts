import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RunnerLogger } from "../src/log.js";
import { AgentProfileError, MAX_SKILLS, parseProfile } from "../src/registry/agent-profile.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { AgentSkillMissingError, verifyAgentFiles } from "../src/registry/verify-agent-files.js";
import { renderWhois } from "../src/whois/render.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";

// agent-skills Requirements 2 and 3: the optional `skills` field of a profile, the check that each
// skill exists under <agentsDir>/.kiro/skills, and the WHOIS `skills:` line.

const base = { nick: "ghost", kiroAgent: "ghost", model: "m", tools: "read", color: 3 } as const;
const FILE = "agents/ghost.json";

const parse = (extra: Record<string, unknown>): ReturnType<typeof parseProfile> =>
  parseProfile({ ...base, ...extra }, FILE);

const rejection = (extra: Record<string, unknown>): AgentProfileError => {
  try {
    parse(extra);
  } catch (err) {
    if (err instanceof AgentProfileError) return err;
    throw err;
  }
  throw new Error("expected the profile to be rejected");
};

describe("profile skills field (Req 2.1, 2.2)", () => {
  it("defaults to an empty list", () => {
    expect(parse({}).skills).toEqual([]);
  });

  it("accepts valid names in order", () => {
    expect(parse({ skills: ["seance-fix-and-commit", "a", "x-1"] }).skills).toEqual([
      "seance-fix-and-commit",
      "a",
      "x-1",
    ]);
  });

  it("accepts exactly the maximum count and a 40-character name", () => {
    const names = Array.from({ length: MAX_SKILLS }, (_, i) => `s${i}`);
    expect(parse({ skills: names }).skills).toHaveLength(MAX_SKILLS);
    expect(parse({ skills: ["a".repeat(40)] }).skills).toEqual(["a".repeat(40)]);
  });

  it.each([
    ["not an array", "seance-fix-and-commit", "must be an array"],
    ["an object", { a: 1 }, "must be an array"],
    ["too many", Array.from({ length: MAX_SKILLS + 1 }, (_, i) => `s${i}`), "at most 8"],
    ["upper case", ["Seance"], "must match"],
    ["empty name", [""], "must match"],
    ["41 characters", ["a".repeat(41)], "must match"],
    ["a path", ["../evil"], "must match"],
    ["a slash", ["a/b"], "must match"],
    ["a space", ["a b"], "must match"],
    ["a dot", ["a.b"], "must match"],
    ["a number", [7], "must match"],
    ["null", [null], "must match"],
    ["a duplicate", ["a", "a"], 'lists "a" twice'],
  ])("rejects %s with a clear error naming the field", (_label, skills, reason) => {
    const err = rejection({ skills });
    expect(err.field).toBe("skills");
    expect(err.file).toBe(FILE);
    expect(err.message).toContain(FILE);
    expect(err.message).toContain(reason);
  });

  it("clips a long invalid entry in the error message", () => {
    const err = rejection({ skills: ["X".repeat(500)] });
    expect(err.message.length).toBeLessThan(200);
  });

  it("the registry skips a profile with invalid skills and logs file and field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-skills-reg-"));
    const errors: { msg: string; fields?: Readonly<Record<string, unknown>> }[] = [];
    const log: RunnerLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (msg, fields) => {
        errors.push({ msg, ...(fields !== undefined ? { fields } : {}) });
      },
    };
    try {
      await writeFile(join(dir, "a-good.json"), JSON.stringify({ ...base, nick: "good", kiroAgent: "good" }));
      await writeFile(join(dir, "b-bad.json"), JSON.stringify({ ...base, nick: "bad", kiroAgent: "bad", skills: ["NO"] }));
      const registry = await AgentRegistry.load(dir, log);
      expect(registry.all().map((p) => p.nick)).toEqual(["good"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.fields).toMatchObject({ file: join(dir, "b-bad.json"), field: "skills" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A temp agents dir with profile `ghost` listing `skills`, its Kiro agent file, and `files`. */
async function withAgentsDir(
  skills: readonly string[],
  files: Readonly<Record<string, string>>,
  fn: (dir: string, registry: AgentRegistry) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "seance-skills-"));
  const noop = (): void => undefined;
  try {
    await writeFile(join(dir, "ghost.json"), JSON.stringify({ ...base, skills }));
    await mkdir(join(dir, ".kiro", "agents"), { recursive: true });
    await writeFile(join(dir, ".kiro", "agents", "ghost.json"), "{}");
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    const registry = await AgentRegistry.load(dir, { debug: noop, info: noop, warn: noop, error: noop });
    await fn(dir, registry);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SKILL = "---\nname: one\ndescription: d\n---\n";

describe("verifyAgentFiles for skills (Req 2.3)", () => {
  it("passes when every listed skill has a SKILL.md", async () => {
    await withAgentsDir(["one"], { ".kiro/skills/one/SKILL.md": SKILL }, async (dir, registry) => {
      await expect(verifyAgentFiles(registry, dir)).resolves.toBeUndefined();
    });
  });

  it("refuses an unknown skill, naming the profile, the skill and the expected path", async () => {
    await withAgentsDir(["one", "missing"], { ".kiro/skills/one/SKILL.md": SKILL }, async (dir, registry) => {
      const err = await verifyAgentFiles(registry, dir).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentSkillMissingError);
      const missing = err as AgentSkillMissingError;
      const expectedPath = join(dir, ".kiro", "skills", "missing", "SKILL.md");
      expect(missing.skill).toBe("missing");
      expect(missing.expectedPath).toBe(expectedPath);
      expect(missing.message).toContain(join(dir, "ghost.json"));
      expect(missing.message).toContain('"missing"');
      expect(missing.message).toContain(expectedPath);
    });
  });

  it("refuses a SKILL.md that is a directory", async () => {
    await withAgentsDir(["one"], { ".kiro/skills/one/SKILL.md/x": "" }, async (dir, registry) => {
      await expect(verifyAgentFiles(registry, dir)).rejects.toThrow(/not a regular file/);
    });
  });

  it("refuses a skill that a symlink leads out of the agents directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "seance-skills-outside-"));
    try {
      await writeFile(join(outside, "SKILL.md"), SKILL);
      await withAgentsDir(["one"], {}, async (dir, registry) => {
        await mkdir(join(dir, ".kiro", "skills"), { recursive: true });
        await symlink(outside, join(dir, ".kiro", "skills", "one"));
        await expect(verifyAgentFiles(registry, dir)).rejects.toThrow(AgentSkillMissingError);
        await expect(verifyAgentFiles(registry, dir)).rejects.toThrow(/resolves outside/);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not look for a skills directory when no profile lists skills", async () => {
    await withAgentsDir([], {}, async (dir, registry) => {
      await expect(verifyAgentFiles(registry, dir)).resolves.toBeUndefined();
    });
  });
});

describe("WHOIS skills line (Req 3.1)", () => {
  it("follows the tools line when the profile lists skills", () => {
    const snap = new WhoisSnapshot();
    snap.register("coder", { model: "m", tools: "fs", skills: ["a", "b"] });
    const lines = renderWhois(snap.get("coder"));
    expect(lines.slice(0, 3)).toEqual(["model: m", "tools: fs", "skills: a, b"]);
  });

  it("is absent for an empty list and when no skills are given", () => {
    const snap = new WhoisSnapshot();
    snap.register("coder", { model: "m", tools: "fs", skills: [] });
    snap.register("reviewer", { model: "m", tools: "fs" });
    for (const nick of ["coder", "reviewer"]) {
      const lines = renderWhois(snap.get(nick));
      expect(lines.some((l) => l.startsWith("skills:"))).toBe(false);
      expect(lines.slice(0, 3)).toEqual(["model: m", "tools: fs", "status: idle"]);
    }
  });

  it("copies the list, so a later change to the caller's array does not reach WHOIS", () => {
    const snap = new WhoisSnapshot();
    const skills = ["a"];
    snap.register("coder", { model: "m", tools: "fs", skills });
    skills.push("b");
    expect(renderWhois(snap.get("coder"))).toContain("skills: a");
  });

  it("keeps whole names within the 320 line budget and counts the rest", () => {
    const snap = new WhoisSnapshot();
    // Eight 40-character names: 342 bytes in full, over the 300-byte budget.
    const skills = Array.from({ length: MAX_SKILLS }, (_, i) => `${"s".repeat(38)}${String(i).padStart(2, "0")}`);
    snap.register("coder", { model: "m", tools: "fs", skills });
    const line = renderWhois(snap.get("coder")).find((l) => l.startsWith("skills:")) ?? "";
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(300);
    const match = /^skills: (.*), \+(\d) more$/.exec(line);
    expect(match).not.toBeNull();
    const shown = (match?.[1] ?? "").split(", ");
    // Every shown name is whole, in order, and shown plus counted is the full list.
    expect(shown).toEqual(skills.slice(0, shown.length));
    expect(shown.length + Number(match?.[2])).toBe(MAX_SKILLS);
  });

  it("P1 the skills line never exceeds the budget and never cuts a name", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,40}$/), { minLength: 1, maxLength: MAX_SKILLS }), (skills) => {
        const snap = new WhoisSnapshot();
        snap.register("coder", { model: "m", tools: "fs", skills });
        const line = renderWhois(snap.get("coder")).find((l) => l.startsWith("skills:")) ?? "";
        expect(line.length).toBeLessThanOrEqual(300);
        const body = line.slice("skills: ".length).replace(/, \+\d+ more$/, "");
        const shown = body.split(", ");
        expect(shown).toEqual(skills.slice(0, shown.length));
      }),
    );
  });
});
