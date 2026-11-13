// sandbox-api-key-auth Requirement 8: the agent can neither print the environment that holds
// KIRO_API_KEY nor repeat the key, raw or encoded, on IRC. Both are textual floors.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isEnvironPath, matchDenyList, referencesKeyReader } from "../src/permissions/deny-list.js";
import { decide, type PolicyMode } from "../src/permissions/policy.js";
import { MIN_FRAGMENT, SecretRedactor, variantsOf } from "../src/output/secret-redactor.js";

const WT = "/wt";

const READERS = [
  "env",
  "printenv",
  "printenv HOME",
  "printenv KIRO_API_KEY",
  "export -p",
  "export",
  "declare -x",
  "typeset -p",
  "set",
  "env -i",
  "env FOO=1",
  "env -u HOME",
  "cat /proc/self/environ",
  "cat /proc/1/environ",
  "cat /proc/*/environ",
  "tr '\\0' '\\n' < /proc/self/environ",
  "echo $KIRO_API_KEY",
  "echo ${KIRO_API_KEY}",
  "./bin/env | grep KIRO",
  "ls; env",
  "git status && printenv",
  "eval env",
  'eval "printenv HOME"',
  "eval 'sh -c env'",
  "echo env | sh",
  "printf 'env' | bash",
  "bash <<< env",
  "cat x | bash -s",
  "sh << EOF",
  "echo env | env sh",
  "sudo -u root env",
  "exec -a x env",
  "xargs -I {} printenv",
  "time -o out.txt printenv",
  "sudo --user=root printenv",
  "sudo -u root -g wheel sh -c env",
  "cat /pr?c/self/environ",
  "cat /p*/self/environ",
  "cat /[p]roc/1/environ",
  "cat /pr?c/self/envi*",
];
const HARMLESS = [
  "env FOO=1 git status",
  "env -u HOME git log",
  "env -- ls",
  "git status",
  "cat /proc/cpuinfo",
  "export FOO=1",
  "set -e",
  "ls -la src",
  "echo hello",
  "npm test",
  "sh script.sh",
  'bash -c "git status"',
  "git log | sort",
  'eval "git status"',
  "sudo -u root git status",
  "xargs -n 1 echo",
  "time -o out.txt npm test",
  "cat p*/x/notes.txt",
];

describe("key readers in shell commands (8.1, 8.2, 8.4)", () => {
  it.each(READERS)("denies %j as protected-path", (command) => {
    expect(referencesKeyReader(command)).toBe(true);
    expect(matchDenyList(command, WT)).toEqual({ reason: "protected-path" });
  });

  it.each(HARMLESS)("allows %j", (command) => {
    expect(referencesKeyReader(command)).toBe(false);
    expect(matchDenyList(command, WT)).toBeUndefined();
  });

  it("denies a shell tool call that dumps the environment, in every mode", () => {
    for (const mode of ["op", "voice", "none"] as const) {
      const r = decide({ mode, tool: { kind: "execute", command: "printenv", paths: [] }, worktree: WT });
      expect(r).toEqual({ decision: "reject_once", reason: "protected-path" });
    }
  });

  const wrapper = fc.constantFrom("", "command ", "sudo ", "sudo -E ", "nohup ", "exec ", "builtin ", "time ", "FOO=1 ", "xargs ");
  const prefix = fc.constantFrom("", "ls; ", "true && ", "cd src; ", "git status | ");
  const suffix = fc.constantFrom("", " | grep KIRO", " > out.txt", " ; ls", " | sort");
  /** Hides the command word from naive matching: quotes, backslashes, letter case, a path. */
  const disguise = (word: string, how: number): string =>
    how === 0 ? word : how === 1 ? `"${word}"` : how === 2 ? word.slice(0, 1) + "''" + word.slice(1) : how === 3 ? word.toUpperCase() : "./bin/" + word;

  it("P11 key readers denied", () => {
    const reader = fc.tuple(
      fc.constantFrom("env", "printenv", "export -p", "declare -x", "set", "env -i", "env A=1 B=2", "cat /proc/self/environ", "echo $KIRO_API_KEY"),
      fc.integer({ min: 0, max: 4 }),
    );
    fc.assert(
      fc.property(prefix, wrapper, reader, suffix, (pre, wrap, [cmd, how], post) => {
        const [word = "", ...rest] = cmd.split(" ");
        const command = pre + wrap + [disguise(word, how), ...rest].join(" ") + post;
        expect(matchDenyList(command, WT)).toEqual({ reason: "protected-path" });
      }),
      { numRuns: 300 },
    );
  });

  it("P12 harmless env use passes", () => {
    const ok = fc.constantFrom("git status", "ls -la", "npm test", "cat README.md", "env FOO=1 git status", "env -u HOME git log", "export X=1", "set -e");
    fc.assert(
      fc.property(fc.constantFrom("", "ls; ", "true && "), fc.constantFrom("", "command ", "nohup ", "FOO=1 "), ok, fc.constantFrom("", " | sort", " ; ls"), (pre, wrap, cmd, post) => {
        expect(referencesKeyReader(pre + wrap + cmd + post)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("environ paths in tool calls (8.3)", () => {
  it("recognises environ files under proc, and nothing else", () => {
    for (const p of ["/proc/self/environ", "/proc/1/environ", "/proc/thread-self/environ", "/proc/1/task/2/environ", "/PROC/SELF/ENVIRON", "\\proc\\self\\environ", "proc/self/environ"]) {
      expect(isEnvironPath(p)).toBe(true);
    }
    for (const p of ["/proc/cpuinfo", "/wt/src/environ.ts", "/wt/environ", "/wt/proc-environ"]) expect(isEnvironPath(p)).toBe(false);
  });

  it("P13 environ paths rejected", () => {
    const modes: readonly PolicyMode[] = ["op", "voice", "none"];
    fc.assert(
      fc.property(
        fc.constantFrom(...modes),
        fc.constantFrom("read", "search", "edit", "delete"),
        fc.constantFrom("self", "thread-self", "1", "4242", "*"),
        fc.boolean(),
        (mode, kind, pid, viaWorktree) => {
          const target = "/proc/" + pid + "/environ";
          // A raw path that looks harmless but resolves to environ is caught too.
          const raw = viaWorktree ? WT + "/link" : target;
          const r = decide({ mode, tool: { kind, paths: [{ raw, resolved: target }] }, worktree: WT });
          expect(r).toEqual({ decision: "reject_once", reason: "protected-path" });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects a read by +o of /proc/self/environ", () => {
    const r = decide({ mode: "op", tool: { kind: "read", paths: [{ raw: "/proc/self/environ", resolved: "/proc/self/environ" }] }, worktree: WT });
    expect(r).toEqual({ decision: "reject_once", reason: "protected-path" });
  });
});

/** KIRO_API_KEY-like values with multi-byte characters. */
const keyArb = fc
  .array(fc.constantFrom(..."abcdefXYZ0123456789-_\u00e9\u65e5\u672c\u{1F600}"), { minLength: 8, maxLength: 48 })
  .map((cs) => "ksk_" + cs.join(""));

describe("SecretRedactor covers the API key like the login tokens (8.5 to 8.8)", () => {
  it("P14 redactor removes variants", () => {
    fc.assert(
      fc.property(keyArb, fc.constantFrom("raw", "variant", "fragment"), fc.nat(), (key, form, seed) => {
        // The runner builds the shared redactor the same way: new SecretRedactor([config.kiroApiKey, ...authSecrets]).
        const r = new SecretRedactor([key]);
        const variants = variantsOf(key);
        const v = variants[seed % variants.length] ?? key;
        const start = seed % (v.length - MIN_FRAGMENT + 1);
        const leaked = form === "raw" ? key : form === "variant" ? v : v.slice(start, start + MIN_FRAGMENT);
        const out = r.redact("here it is: " + leaked + " ok");
        expect(out).not.toContain(leaked);
        expect(out).toContain("here it is:");
      }),
      { numRuns: 200 },
    );
  });

  it("removes base64, base64url and hex forms of a realistic key", () => {
    const key = "ksk_live_Abc123Def456Ghi789";
    const r = new SecretRedactor([key]);
    const forms = [Buffer.from(key).toString("base64"), Buffer.from(key).toString("base64url"), Buffer.from(key).toString("hex"), Buffer.from(key).toString("hex").toUpperCase()];
    for (const f of forms) expect(r.redact("x " + f + " y")).not.toContain(f.slice(0, MIN_FRAGMENT));
  });

  it("P15 short keys whole only", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9]{1,7}$/), (key) => {
        const r = new SecretRedactor([key]);
        expect(r.redact("a " + key + " b")).not.toContain(" " + key + " ");
        // Encodings of a short key are not removed: too likely to match ordinary text.
        const b64 = Buffer.from(key).toString("base64");
        if (!b64.includes(key)) expect(r.redact("a " + b64 + " b")).toContain(b64);
      }),
      { numRuns: 100 },
    );
  });
});

describe("shell scripts and environ globs (Requirement 13)", () => {
  const DENIED = [
    "sh -c env",
    "bash -c printenv",
    "env sh -c env",
    'bash -lc "export -p"',
    "env printenv",
    "sudo sh -c 'printenv HOME'",
    "zsh -ec 'env | sort'",
    "cat /proc/self/envi*",
    "cat /proc/self/env?ron",
    "cat /proc/self/*",
    "cat /proc/self/env[i]ron",
    "cd /proc/self; cat envir*",
    "eval eval env",
  ];
  const ALLOWED = ['sh -c "git status"', 'bash -c "env FOO=1 git status"', "env FOO=1 git status", "cat /proc/cpuinfo", "ls src/*.ts"];

  it("recognises globbed proc environ paths", () => {
    for (const p of ["/pr?c/self/environ", "/p*/self/environ", "/[p]roc/1/environ"]) expect(isEnvironPath(p)).toBe(true);
  });

  it("eval chains: 4 levels around a harmless command pass, 5 fail closed", () => {
    const four = "eval eval eval eval git status";
    const five = "eval eval eval eval eval git status";
    expect(referencesKeyReader(four)).toBe(false);
    expect(matchDenyList(four, WT)).toBeUndefined();
    expect(matchDenyList(five, WT)).toEqual({ reason: "protected-path" });
  });

  it("P18 stdin-fed shells, eval and wrapper option values denied", () => {
    const shell = fc.constantFrom("sh", "bash", "zsh", "dash");
    const piped = fc.tuple(
      fc.constantFrom("echo env", "cat script.txt", "printf x"),
      fc.constantFrom("", "sudo ", "sudo -u root ", "env ", "nohup "),
      shell,
      fc.constantFrom("", " -s", " -i", " -l"),
    );
    fc.assert(
      fc.property(piped, ([producer, wrap, sh, opts]) => {
        expect(matchDenyList(`${producer} | ${wrap}${sh}${opts}`, WT)).toEqual({ reason: "protected-path" });
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(shell, fc.constantFrom("env", "x", "\"printenv\"", "$(cat f)"), (sh, word) => {
        expect(matchDenyList(`${sh} <<< ${word}`, WT)).toEqual({ reason: "protected-path" });
      }),
      { numRuns: 100 },
    );
    const reader = fc.constantFrom("env", "printenv", "export -p");
    const valueWrapper = fc.constantFrom("sudo -u root", "exec -a x", "xargs -I {}", "time -o out.txt", "sudo --user=root");
    fc.assert(
      fc.property(valueWrapper, reader, (w, r) => {
        expect(matchDenyList(`${w} ${r}`, WT)).toEqual({ reason: "protected-path" });
        expect(matchDenyList(`eval ${r}`, WT)).toEqual({ reason: "protected-path" });
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(shell, (sh) => {
        expect(referencesKeyReader(`${sh} script.sh`)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it.each(DENIED)("denies %j as protected-path", (command) => {
    expect(matchDenyList(command, WT)).toEqual({ reason: "protected-path" });
  });

  it.each(ALLOWED)("allows %j", (command) => {
    expect(referencesKeyReader(command)).toBe(false);
    expect(matchDenyList(command, WT)).toBeUndefined();
  });

  const LAYERS = ["sh -c", "bash -lc", "env sh -c", "sudo bash -c", "env FOO=1 dash -c"] as const;
  /** Wraps `inner` in one shell layer using double quotes, escaping backslashes and quotes. */
  const wrap = (layer: string, inner: string): string => `${layer} "${inner.replace(/[\\"]/g, "\\$&")}"`;
  const nest = (layers: readonly string[], core: string): string => layers.reduceRight((inner, layer) => wrap(layer, inner), core);
  const layersArb = (min: number, max: number) => fc.array(fc.constantFrom(...LAYERS), { minLength: min, maxLength: max });

  it("P16 shell -c scripts checked recursively", () => {
    const reader = fc.constantFrom("env", "printenv", "export -p", "cat /proc/self/environ");
    const harmless = fc.constantFrom("git status", "ls -la", "npm test");
    fc.assert(
      fc.property(layersArb(1, 4), reader, (layers, core) => {
        expect(matchDenyList(nest(layers, core), WT)).toEqual({ reason: "protected-path" });
      }),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(layersArb(1, 4), harmless, (layers, core) => {
        expect(referencesKeyReader(nest(layers, core))).toBe(false);
      }),
      { numRuns: 150 },
    );
  });

  it("refuses a harmless command nested 5 levels deep, allows 4", () => {
    const five = nest(Array(5).fill("sh -c"), "git status");
    const four = nest(Array(4).fill("sh -c"), "git status");
    expect(matchDenyList(five, WT)).toEqual({ reason: "protected-path" });
    expect(referencesKeyReader(four)).toBe(false);
    expect(matchDenyList(four, WT)).toBeUndefined();
  });

  it("P17 /proc environ globs denied", () => {
    const WORD = "environ";
    const glob = fc.oneof(
      // Replace a non-empty subset of positions with `?`.
      fc
        .subarray([...Array(WORD.length).keys()], { minLength: 1 })
        .map((idx) => [...WORD].map((c, i) => (idx.includes(i) ? "?" : c)).join("")),
      // Replace a suffix (possibly everything) with `*`.
      fc.integer({ min: 0, max: WORD.length - 1 }).map((i) => WORD.slice(0, i) + "*"),
      // Wrap one character in a bracket class.
      fc.integer({ min: 0, max: WORD.length - 1 }).map((i) => WORD.slice(0, i) + "[" + WORD[i] + "]" + WORD.slice(i + 1)),
    );
    fc.assert(
      fc.property(glob, (g) => {
        expect(matchDenyList(`cat /proc/self/${g}`, WT)).toEqual({ reason: "protected-path" });
        expect(isEnvironPath(`/proc/self/${g}`)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});
