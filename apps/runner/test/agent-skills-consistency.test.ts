import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProfile } from "../src/registry/agent-profile.js";

// agent-skills Requirement 4: the committed agents/ tree is consistent. Every skill a profile
// lists exists with valid front matter and is referenced by that profile's Kiro agent config,
// and no Kiro agent config points at a skill outside agents/.kiro/skills.

const AGENTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../agents");
const SKILLS_DIR = join(AGENTS, ".kiro", "skills");
const MAX_SKILL_LINES = 60;
/** Built from fragments so the trademark never appears in the repository text. */
const FORBIDDEN_WORD = ["m", "IRC"].join("");

/** The exact resource string a Kiro agent config uses for one skill (Step 0 of the spec). */
const skillResource = (name: string): string => `skill://.kiro/skills/${name}/SKILL.md`;

interface FrontMatter {
  readonly name?: string;
  readonly description?: string;
}

/** Parses the `---` delimited `key: value` block at the start of a SKILL.md. */
function frontMatter(text: string): FrontMatter | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m?.[1] === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined) out[kv[1]] = kv[2].trim();
  }
  return out;
}

async function profiles(): Promise<readonly ReturnType<typeof parseProfile>[]> {
  const names = (await readdir(AGENTS)).filter((n) => n.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (n) => parseProfile(JSON.parse(await readFile(join(AGENTS, n), "utf8")) as unknown, n)),
  );
}

async function kiroConfig(name: string): Promise<{ readonly resources?: readonly unknown[] }> {
  return JSON.parse(await readFile(join(AGENTS, ".kiro", "agents", `${name}.json`), "utf8")) as {
    readonly resources?: readonly unknown[];
  };
}

describe("agents/ skills consistency (Req 4)", () => {
  it("every listed skill exists with front matter name and description, within the line limit", async () => {
    const all = await profiles();
    const listed = all.flatMap((p) => p.skills ?? []);
    expect(listed.length).toBeGreaterThan(0);
    for (const skill of listed) {
      const text = await readFile(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      const fm = frontMatter(text);
      expect(fm, `${skill}: front matter`).toBeDefined();
      expect(fm?.name, `${skill}: name`).toBe(skill);
      expect((fm?.description ?? "").length, `${skill}: description`).toBeGreaterThan(20);
      expect(text.split("\n").length, `${skill}: line count`).toBeLessThanOrEqual(MAX_SKILL_LINES + 1);
    }
  });

  it("each profile's Kiro agent config references exactly the profile's skills", async () => {
    for (const p of await profiles()) {
      const config = await kiroConfig(p.kiroAgent);
      const skillRefs = (config.resources ?? []).filter(
        (r): r is string => typeof r === "string" && r.startsWith("skill://"),
      );
      expect(skillRefs.sort(), `${p.kiroAgent}.json resources`).toEqual((p.skills ?? []).map(skillResource).sort());
    }
  });

  it("no Kiro agent config references a skill outside agents/.kiro/skills", async () => {
    const configs = (await readdir(join(AGENTS, ".kiro", "agents"))).filter((n) => n.endsWith(".json"));
    const known = new Set(await readdir(SKILLS_DIR));
    for (const file of configs) {
      const config = await kiroConfig(file.replace(/\.json$/, ""));
      for (const r of config.resources ?? []) {
        if (typeof r !== "string" || !r.startsWith("skill://")) continue;
        // One exact, relative path per skill: no globs, no absolute paths, no `..`.
        const m = /^skill:\/\/\.kiro\/skills\/([a-z0-9-]{1,40})\/SKILL\.md$/.exec(r);
        expect(m, `${file}: ${r}`).not.toBeNull();
        expect(known.has(m?.[1] ?? ""), `${file}: ${r} names an existing skill`).toBe(true);
      }
    }
  });

  it("every skill directory is used by some profile, and no skill text holds a host path or the trademark", async () => {
    const used = new Set((await profiles()).flatMap((p) => p.skills ?? []));
    for (const dir of await readdir(SKILLS_DIR)) {
      expect(used.has(dir), `${dir} is listed by a profile`).toBe(true);
      const text = await readFile(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\/);
      expect(text.toLowerCase()).not.toContain(FORBIDDEN_WORD.toLowerCase());
      expect(text).not.toMatch(/(api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/i);
    }
  });
});
