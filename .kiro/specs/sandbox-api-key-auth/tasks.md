# Implementation Plan: Sandbox API Key Auth

## Overview

Add `KIRO_API_KEY` as a second credential path in podman mode. The key is forwarded by name only (`-e KIRO_API_KEY`) and its value travels solely in the environment of the spawned `podman run`. `SEANCE_SANDBOX_AUTH_DIR` becomes optional when the key is set. The language is TypeScript (strict, ESM, `.js` import extensions), tested with vitest and fast-check. Work proceeds bottom-up: config, path and argv builder, launcher, runner wiring, docs, then the final gate. Test files live in `apps/runner/test/` as named in the requirements. Do not modify `apps/web/next-env.d.ts`.

## Tasks

- [x] 1. Config parsing and startup validation
  - [x] 1.1 Make the Auth_Dir optional and validate the key in `apps/runner/src/config.ts`
    - Change `PodmanSandboxConfig.authDir` to `string | undefined` and `ignored` to `readonly "SEANCE_KIRO_BIN"[]`
    - In `parseSandbox`: unset or whitespace-only Auth_Dir gives `undefined`, otherwise keep `assertMountSafe`
    - Read `KIRO_API_KEY` (empty counts as unset); reject NUL, CR or LF with a `ConfigError("KIRO_API_KEY", ...)` that omits the value
    - Throw a `ConfigError` naming `SEANCE_SANDBOX_AUTH_DIR` and `KIRO_API_KEY` when neither is set
    - Run the `validateRunnerPaths` directory and realpath checks only when `authDir` is defined
    - Add the pure export `sandboxAuthWarnings(config)` returning exactly one warning when the mode is `podman` and both are set; the message names both variables, states login precedence and never includes the value
    - Leave mode `none` unchanged
    - _Requirements: 2.6, 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 1.2 Write property test and examples for the credential matrix
    - In `apps/runner/test/sandbox-config.test.ts`
    - **Property 7: Credential matrix at startup** (title `P7 credential matrix at startup`)
    - Examples: neither set (error names both variables, value absent), key only, Auth_Dir only, both set (accepted, one warning), mode `none` unchanged
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 7.6**

  - [x] 1.3 Write property test for control characters in the key
    - In `apps/runner/test/sandbox-config.test.ts`
    - **Property 8: Control characters in the key are rejected** (title `P8 control characters in key rejected`)
    - Add an example for a CR/LF key
    - **Validates: Requirements 2.6, 7.6**

- [x] 2. Optional Auth_Dir in mount paths and argv builder
  - [x] 2.1 Make `authDir` optional in `apps/runner/src/sandbox/paths.ts`
    - `MountPaths.authDir` becomes optional
    - `assertMountPaths` skips the two auth overlap and containment checks when it is undefined; all other checks stay
    - `resolveMountPaths` passes it through
    - _Requirements: 3.2, 3.5_

  - [x] 2.2 Add the key flag and conditional auth mount in `apps/runner/src/sandbox/podman-args.ts`
    - `config.authDir` becomes `string | undefined`; add `forwardApiKey: boolean` to `PodmanRunInput`
    - Validate and mount the Auth_Dir only when defined, keeping the mount in its existing position
    - Emit `-e`, `KIRO_API_KEY` after the `forwardEnv` entries and before the image when `forwardApiKey` is true
    - Keep `KIRO_API_KEY` in `NEVER_FORWARDED`; leave `buildProbeArgs` untouched
    - _Requirements: 1.1, 1.3, 1.6, 2.2, 3.1, 3.2, 5.1, 5.2, 5.3_

  - [x] 2.3 Write property test for key never in argv
    - In `apps/runner/test/podman-args.test.ts`
    - **Property 1: Key never in argv** (title `P1 key never in argv`)
    - Generate keys with multi-byte UTF-8 characters; assert no element contains the key and the argv equals the keyless argv plus exactly one `-e` / `KIRO_API_KEY` pair before the image
    - Add examples: flag present and name-only when set, absent when not (7.1), `forwardEnv` rejects `KIRO_API_KEY`, existing golden argv unchanged
    - **Validates: Requirements 1.1, 1.6, 2.1, 2.2, 5.1, 5.2, 7.1, 7.5**

  - [x] 2.4 Write property test for the auth mount
    - In `apps/runner/test/podman-args.test.ts`
    - **Property 2: Auth mount present exactly when Auth_Dir is set** (title `P2 auth mount iff auth dir`)
    - Add examples: mount absent when unset, present when set (7.2)
    - **Validates: Requirements 3.1, 3.2, 4.4, 7.2**

  - [x] 2.5 Write unit tests for `assertMountPaths` with `authDir` undefined
    - In `apps/runner/test/paths.test.ts`
    - Other overlap and containment checks still run
    - _Requirements: 3.5_

- [x] 3. Launcher key handling
  - [x] 3.1 Thread the key through `apps/runner/src/sandbox/launcher.ts`
    - Add `LauncherOptions.apiKey?: string`; an empty string counts as unset
    - `preflight()`: run the auth `stat` and `auth-missing` check only when `authDir` is defined; keep version, rootless, image and probe checks
    - `spec()`: pass `authDir` conditionally to `resolveMountPaths`, pass `forwardApiKey` to the builder, and add `env["KIRO_API_KEY"]` to the Spawn_Spec env only when the key is set
    - Keep `podmanEnv()` key-free so every other podman call stays key-free; keep `KIRO_API_KEY` in `HOST_ONLY`
    - Pass podman stderr through `redactValues` with the key wherever it is logged or embedded in a `SandboxError`
    - Never use `podman exec`
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.3, 3.4, 3.5, 5.3_

  - [x] 3.2 Add `redactSpawnSpec` to `apps/runner/src/sandbox/launcher.ts` (superseded)
    - Implemented earlier, now superseded by the updated design: the Runner never logs a Spawn_Spec, so the function is removed in task 10.1
    - _Requirements: 2.4, 10.1_

  - [x] 3.3 Write property test and examples for the Spawn_Spec env
    - In `apps/runner/test/launcher.test.ts` (or the existing launcher test file), using a fake `PodmanExec`
    - **Property 3: Spawn_Spec env carries the key, argv does not** (title `P3 spec env carries key`)
    - Examples: no `exec` subcommand recorded; preflight with unset Auth_Dir skips the stat check and still runs the probe
    - **Validates: Requirements 1.2, 1.3, 1.4, 3.4, 7.3**

  - [x] 3.4 Write property test for key-free podman calls
    - In the same launcher test file
    - **Property 4: Only the agent run receives the key** (title `P4 only agent run receives key`)
    - Cover `preflight`, `quickCheck`, `remove`, `sweep` and the probe `run`
    - **Validates: Requirements 1.5, 5.3, 7.4**

  - [x] 3.5 Write property test for no key leak in logs or errors
    - In the same launcher test file, with a recording logger and failing fake calls whose stderr echoes the key
    - **Property 5: Launcher never leaks the key in logs or errors** (title `P5 launcher never leaks key`)
    - **Validates: Requirements 2.3**

  - [x] 3.6 Write the masked Spawn_Spec test and redactor example (partly superseded)
    - Property 6 (`P6 logged spawn spec masked`) is removed with `redactSpawnSpec`; its test is deleted in task 10.2
    - Example kept: `SecretRedactor([key])` strips the key from agent text when no Auth_Dir is set
    - **Validates: Requirements 2.5, 5.4**

- [x] 4. Runner wiring
  - [x] 4.1 Wire the key in `apps/runner/src/runner.ts` and update the `apps/runner/src/harness/spawn.ts` comment
    - Pass `apiKey: config.kiroApiKey` to `new PodmanLauncher(...)`
    - Remove the `KIRO_API_KEY` branch of the `ignored` warning loop
    - Log each entry of `sandboxAuthWarnings(config)` with `logger.warn` at startup
    - Call `readAuthSecrets` only when `authDir` is defined, else `authSecrets = []`; keep `config.kiroApiKey` in the shared `SecretRedactor`
    - Update the `spawn.ts` comment: in podman mode the key is in the podman process env, not argv
    - _Requirements: 1.2, 2.5, 4.5, 4.6, 5.4_

- [x] 5. Documentation
  - [x] 5.1 Update the Sandbox_Docs
    - `README.md` (runner table and Secrets), `DESIGN.md` (harness section near line 190), `docs/SANDBOX.md`, `deploy/seance.env.example`
    - Describe name-only forwarding with the value in the podman process env, `SEANCE_SANDBOX_AUTH_DIR` optional with a key and required otherwise, and login precedence over the key
    - State the key is readable inside the Agent_Container; recommend a dedicated key with a usage limit, revoked after January 29, 2027
    - Remove any statement that `KIRO_API_KEY` is never forwarded in podman mode (verify with a search)
    - Add `KIRO_API_KEY=` with a placeholder only to `deploy/seance.env.example`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [x] 6. Final checkpoint - Run typecheck and tests at the repository root
  - Run `pnpm typecheck` at the repository root and fix any errors
  - Run `pnpm test` at the repository root and fix any failures; use fakes only, never a real `podman` or `kiro-cli`
  - Confirm `apps/web/next-env.d.ts` is unmodified (revert any change a build made to it)
  - Both commands must exit with code 0; ask the user if questions arise.
  - _Requirements: 7.8, 7.9_

- [x] 7. Whitespace-only key handling
  - [x] 7.1 Add `readApiKey(env)` in `apps/runner/src/config.ts`
    - Return `undefined` when `KIRO_API_KEY` is unset or `""`
    - Reject NUL, CR or LF first with `ConfigError("KIRO_API_KEY", "KIRO_API_KEY contains a NUL, CR or LF character")`, value omitted
    - Return `undefined` when `raw.trim() === ""`; otherwise return `raw` unchanged, keeping surrounding whitespace
    - Use it in both `parseSandbox` and `loadRunnerConfig` so `kiroApiKey` is `undefined` for a blank key in both modes, and a podman config with a blank key and no Auth_Dir fails with the Requirement 4.1 error
    - Keep the `key !== undefined && key !== ""` guard in `sandboxAuthWarnings` and `harness/spawn.ts` `buildSpawnSpec`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 7.2 Write property test for whitespace-only keys
    - In `apps/runner/test/sandbox-config.test.ts`
    - **Property 9: Whitespace-only key is unset, other keys are kept** (title `P9 whitespace-only key is unset`)
    - Use Unicode whitespace arbitraries without NUL, CR, LF
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.5**

  - [x] 7.3 Write property test for control characters and the 12.5 examples
    - In `apps/runner/test/sandbox-config.test.ts`
    - **Property 10: Control characters win over the blank check** (title `P10 control chars beat blank check`)
    - Examples: whitespace-only key in podman mode with and without `SEANCE_SANDBOX_AUTH_DIR`, in `none` mode, and a key with surrounding whitespace kept unchanged
    - **Validates: Requirements 9.4, 12.5**

- [x] 8. Key reader and Environ_Path protection
  - [x] 8.1 Add `referencesKeyReader` and `isEnvironPath` to `apps/runner/src/permissions/deny-list.ts`
    - `referencesKeyReader(command)`: strip quotes and backslashes, lower-case, then match `kiro_api_key`, the Environ_Path regexes (`/proc/(self|thread-self|digits|glob)/environ` plus the looser `/proc/...environ` form), and reader commands found via `simpleCommands` (`printenv`, `export`, `declare`/`typeset` with `-x`/`-p`, bare `set`, `env` without a command operand)
    - Skip wrappers `command`, `exec`, `sudo`, `xargs`, `nohup`, `time`, `builtin` and their options, use `baseName` of the command word, and restart the scan after each wrapper
    - Call it from `matchDenyList` right after `referencesAuthPath`, returning `{ reason: "protected-path" }`
    - `isEnvironPath(path)`: normalise backslashes and case, true when an `environ` segment follows `self`, `thread-self`, digits or a glob segment under an earlier `proc` segment
    - Pure functions, no I/O
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 8.2 Reject Environ_Paths in `apps/runner/src/permissions/policy.ts`
    - Extend step 2b of `evaluate`: `isEnvironPath(p.raw) || isEnvironPath(p.resolved)` returns `reject("protected-path")`, alongside the `isAuthPath` checks
    - Must hold for modes `op`, `voice` and `none`, and for read and write tools
    - _Requirements: 8.3_

  - [x] 8.3 Write property tests and examples for the deny list
    - In `apps/runner/test/deny-list.test.ts` (or the existing deny-list test file)
    - **Property 11: Key readers are denied** (title `P11 key readers denied`), using template, wrapper and quoting arbitraries so every command is a reader by construction
    - **Property 12: Harmless env use and ordinary commands pass** (title `P12 harmless env use passes`)
    - Examples rejected: `env`, `printenv`, `printenv KIRO_API_KEY`, `cat /proc/self/environ`, `cat /proc/1/environ`, `cat /proc/*/environ`, `tr '\0' '\n' < /proc/self/environ`, `echo $KIRO_API_KEY`, `/usr/bin/env | grep KIRO`, `ls; env`
    - Examples accepted: `env FOO=1 git status`, `git status`, `cat /proc/cpuinfo`
    - **Validates: Requirements 8.1, 8.2, 8.4, 12.1**

  - [x] 8.4 Write property test for Environ_Path rejection in `decide`
    - In `apps/runner/test/policy.test.ts`
    - **Property 13: Environ paths are rejected for every mode** (title `P13 environ paths rejected`)
    - Example: a read tool in `op` mode on `/proc/self/environ` gives `reject_once` with reason `protected-path`
    - **Validates: Requirements 8.3, 12.2**

- [x] 9. Secret_Redactor coverage
  - [x] 9.1 Write redactor property tests
    - In `apps/runner/test/secret-redactor.test.ts`
    - **Property 14: Redactor removes every Key_Variants form and its fragments** (title `P14 redactor removes variants`), at least 100 cases, multi-byte UTF-8 keys
    - **Property 15: Short keys are redacted whole only** (title `P15 short keys whole only`)
    - **Validates: Requirements 8.5, 8.6, 8.7, 12.3**

  - [x] 9.2 Verify the shared redactor on every output path
    - Check in `apps/runner/src/runner.ts` that one `SecretRedactor([config.kiroApiKey, ...authSecrets])` instance is passed as `redactor` to all channel dependencies (channel text, AWAY, whois, tool notices); change any path that redacts only the raw key to use it
    - Add a runner-level test that sets a key, has the fake agent emit its base64 form on each output path, and asserts the form is removed
    - **Validates: Requirements 8.5, 8.8, 12.4**

- [x] 10. Remove `redactSpawnSpec`
  - [x] 10.1 Delete `redactSpawnSpec` from `apps/runner/src/sandbox/launcher.ts`
    - Remove the function, its export and any call sites; confirm nothing logs a Spawn_Spec, Podman_Process_Env or podman argv
    - _Requirements: 2.4, 10.1_

  - [x] 10.2 Remove its tests and unused imports
    - Delete `apps/runner/test/redact-spawn-spec.test.ts` (and any `redactSpawnSpec` test elsewhere)
    - In `apps/runner/test/sandbox-api-key.test.ts` drop the unused `redactSpawnSpec` import and anything else left unreferenced
    - `pnpm typecheck` must pass
    - _Requirements: 7.7, 10.1, 10.2_

- [x] 11. Update the sandbox integration test
  - [x] 11.1 Update `apps/ircd/test/runner/sandbox.integration.test.ts` and the probe
    - Retitle to `hides host secrets, forwards KIRO_API_KEY as set, has no git metadata, cannot reach the metadata endpoint`
    - Change the in-container probe so `KIRO_API_KEY` prints only `set` or `<unset>`, never the value
    - Assert `toContain("SEANCE_SECRET_CANARY=<unset> KIRO_API_KEY=set")` and `not.toContain("kiro-canary")`
    - Keep the `it.skipIf(!available)` guard and update the Fake_Agent probe source and any fake-podman path in the ircd tests
    - _Requirements: 10.3, 10.4_

- [x] 12. Documentation follow-up
  - [x] 12.1 Update `docs/DEPLOY.md` section 5, `docs/SANDBOX.md`, `README.md` and `deploy/seance.env.example`
    - Remove "the host has no `KIRO_API_KEY`"; state the login is the default and `KIRO_API_KEY` is the documented alternative
    - Add the dedicated-key guidance: used nowhere else, low usage limit at or below the acceptable loss, credits counter plus limit bound the cost of a leak, rotation steps, revoke after January 29, 2027, no personal login on a public host
    - In `docs/SANDBOX.md`: the key is readable inside the container, the egress allow-list note, and the text-only limit of the Deny_List and Secret_Redactor
    - One line each in `README.md` and `deploy/seance.env.example` pointing to `docs/SANDBOX.md`
    - Verify with a search that no "never forwarded" or "no `KIRO_API_KEY`" statement remains
    - _Requirements: 6.4, 6.5, 8.9, 10.5, 11_

- [x] 13. Supersede notes in the agent-sandbox spec
  - [x] 13.1 Annotate `.kiro/specs/agent-sandbox/design.md`
    - Keep the original text of D18, the D10 sentence "`KIRO_API_KEY` is not forwarded at all (D18)", the `authDir` comment, the mount-section sentence, Open Point 2 and Property 3's key sentence; append "Superseded by `sandbox-api-key-auth` (Requirements 1 to 4)" to each
    - _Requirements: 10.6_

  - [x] 13.2 Annotate `.kiro/specs/agent-sandbox/requirements.md`
    - Keep criterion 4 of the configuration requirement (around line 68) and criterion 4 of the environment requirement (around line 135); mark both "Superseded by `sandbox-api-key-auth` Requirements 1 and 4"
    - _Requirements: 10.7_

- [x] 14. Final checkpoint - Run typecheck and tests at the repository root
  - Run `pnpm typecheck` at the repository root and fix any errors
  - Run `pnpm test` at the repository root and fix any failures; use fakes only
  - Confirm `apps/web/next-env.d.ts` is unmodified (revert any change a build made to it)
  - Both commands must exit with code 0; ask the user if questions arise.
  - _Requirements: 7.8, 7.9_

- [x] 15. Deny-list gap closure
  - [x] 15.1 Add `shellWords` and recursive key-reader detection in `apps/runner/src/permissions/deny-list.ts`
    - Add the quote-aware `shellWords(part)`: quotes and backslash escapes removed, a quoted group stays one word, an unterminated quote ends at the end of the part
    - Make `referencesKeyReader(command, depth = 0)` split on `; & | < > ( ) \` { }` and newlines and run `isKeyReaderWords(shellWords(part), depth)` on each part
    - `isKeyReaderWords`: keep the existing wrapper, `printenv`, `export`, `declare`, `typeset` and `set` rules
    - `env` with a command operand recurses on the rest (`env printenv` denied, `env FOO=1 git status` allowed)
    - For `sh`, `bash`, `zsh`, `dash`, `ksh`, `ash` (base name, lower-cased): find the first option matching `/^-[A-Za-z]*c[A-Za-z]*$/`, recurse on the next word with `depth + 1`; at `depth >= 4` return true (fail closed); no `-c` returns false
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 15.2 Add the `/proc` environ glob check in `referencesKeyReader` and `isEnvironPath`
    - In `referencesKeyReader`: when the normalised command mentions `/proc`, any segment (split on `/` and whitespace) containing `*`, `?` or `[` for which `globMatches(segment, "environ")` is true returns true; `cat /proc/cpuinfo` still passes
    - In `isEnvironPath`: also return true when a `proc` segment precedes the last segment and the last segment is a glob for which `globMatches(last, "environ")` is true
    - `decide` in `policy.ts` is unchanged and rejects these as `protected-path`
    - _Requirements: 13.6, 13.7_

  - [x] 15.3 Write property tests P16 and P17 and the examples in `apps/runner/test/key-reader.test.ts`
    - **Property 16: Shell -c scripts are checked recursively** (title `P16 shell -c scripts checked recursively`); build commands by construction (reader or harmless leaf wrapped in generated layers) with a small quoting helper, no oracle re-implementing the matcher; depth at most 4 around a reader denied, around a harmless command allowed, 5 or more shell levels denied
    - **Property 17: /proc environ globs are denied** (title `P17 proc environ globs denied`) for `matchDenyList` and `isEnvironPath`
    - Examples denied: `sh -c env`, `bash -c printenv`, `env sh -c env`, `bash -lc "export -p"`, depth-3 nested `sh -c`, depth-5 nesting, `env printenv`, `cat /proc/self/envi*`, `cat /proc/self/env?ron`, `cat /proc/self/*`, `cat /proc/self/[e]nviron`
    - Examples allowed: `sh -c "git status"`, `bash -c "env FOO=1 git status"`, `cat /proc/cpuinfo`
    - `isEnvironPath` examples for glob last segments
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8**

- [x] 16. Runner-level redaction test
  - [x] 16.1 Add an ircd integration test in `apps/ircd/test/runner` using `startIntegration` and the Fake_Agent
    - Pass `KIRO_API_KEY` through the runner env; no real podman or kiro-cli
    - First check which Fake_Agent script steps exist; add any missing step to the fixture (a tool-call title or notice with free text, an error path)
    - The fake agent emits the raw key and its base64 form as agent text, in a tool notice, and on an error or notice path
    - Collect every IRC line and assert none contains the raw key or its base64 form
    - _Requirements: 13.9, 13.10_

- [x] 17. Exposure documentation
  - [x] 17.1 Update `docs/SANDBOX.md` and `docs/DEPLOY.md`
    - State that `podman inspect` of a running Agent_Container and the host `/proc/<pid>/environ` of the podman process expose the key to the `seance` user and root
    - List the remaining text-deny-list limits: `python -c`, `node -e`, `awk` with `ENVIRON`, `perl`, other encodings, and names built at run time by concatenation or command substitution
    - State that a dedicated, low-limit, rotatable key is the main mitigation
    - _Requirements: 13.11, 13.12, 13.13_

- [x] 18. Supersede notes in the deploy-aws spec
  - [x] 18.1 Annotate `.kiro/specs/deploy-aws/design.md` and `.kiro/specs/deploy-aws/requirements.md`
    - `design.md`: keep decision D7 ("No `KIRO_API_KEY` on the host") text and add the note "Superseded by `sandbox-api-key-auth`"
    - `requirements.md`: keep criterion 1 of the Kiro login requirement (line ~69, "`KIRO_API_KEY` SHALL NOT be used") and add "Superseded by `sandbox-api-key-auth` Requirements 1, 4 and 10"
    - _Requirements: 13.14, 13.15_

- [x] 19. Final checkpoint - Run typecheck and tests at the repository root
  - Run `pnpm typecheck` at the repository root and fix any errors
  - Run `pnpm test` at the repository root and fix any failures; use fakes only
  - Confirm `apps/web/next-env.d.ts` is untouched (revert any change a build made to it)
  - Both commands must exit with code 0; ask the user if questions arise.
  - _Requirements: 13.16, 13.17_

- [x] 20. Final deny-list hardening
  - [x] 20.1 Add separator-aware splitting, stdin-fed shell rejection and `eval` recursion in `apps/runner/src/permissions/deny-list.ts`
    - Make the simple-command split separator-aware and give each part a `piped` flag (true when the part follows a `|`); also detect here-strings (`<<<`) and here-documents (`<<`) attached to the part
    - Reject a `SCRIPT_SHELLS` command (`sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `ash`, `fish`) with no C_Option_Group and no Script_File_Operand that has a Stdin_Script_Source, with reason `protected-path`, without inspecting the script text
    - `sh script.sh`, `bash -c "git status"` and `git log | sort` stay allowed
    - For `eval`, join the words after it with single spaces and recurse on the joined text at depth + 1; fail closed above `MAX_SCRIPT_DEPTH` (4)
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [x] 20.2 Skip per-wrapper option values with `WRAPPER_OPTIONS_WITH_ARG` in `apps/runner/src/permissions/deny-list.ts`
    - Add the `WRAPPER_OPTIONS_WITH_ARG` table: `sudo` `-u -g -C -D -h -p -r -t -U -T` plus the long forms (`--name=value` and `--name value`), `exec` `-a`, `xargs` `-I -L -n -P -s -d -E -a`, `time` `-f -o`; `nohup`, `command` and `builtin` take none
    - In the wrapper-skipping loop of `isKeyReaderWords`, skip each option's value before looking for the Command_Word
    - `sudo -u root env`, `exec -a x env`, `xargs -I {} printenv`, `time -o out.txt printenv` and `sudo --user=root printenv` are denied
    - _Requirements: 14.5, 14.6_

  - [x] 20.3 Add the Proc_Glob segment check to `referencesKeyReader` and `isEnvironPath` in `apps/runner/src/permissions/deny-list.ts`
    - A path with a glob segment (`*`, `?`, `[`) for which `globMatches(segment, "proc")` is true, followed by a later segment matching `environ` literally or as an Environ_Glob, is denied
    - `isEnvironPath` returns true for `/pr?c/self/environ`, `/p*/self/environ` and `/[p]roc/1/environ`, so `decide` in `policy.ts` rejects them as `protected-path` (no change to `policy.ts`)
    - `cat /proc/cpuinfo` stays allowed
    - _Requirements: 14.7, 14.8_

  - [x] 20.4 Write the tests in `apps/runner/test/key-reader.test.ts`
    - List every denied example of Requirement 14 in the DENIED list and assert `matchDenyList` returns reason `protected-path`: `eval env`, `eval "printenv HOME"`, `eval 'sh -c env'`, `echo env | sh`, `printf 'env' | bash`, `bash <<< env`, `cat x | bash -s`, `sudo -u root env`, `exec -a x env`, `xargs -I {} printenv`, `time -o out.txt printenv`, `sudo --user=root printenv`, `/pr?c/self/environ`, `/p*/self/environ`, `/[p]roc/1/environ`
    - Allowed examples: `sh script.sh`, `bash -c "git status"`, `git log | sort`
    - Assert `isEnvironPath` is true for the three Proc_Glob paths
    - Assert an `eval` chain nested deeper than 4 levels is rejected
    - **Property 18: Stdin-fed shells, eval and wrapper option values are denied** (title `P18 stdin shells eval wrapper options denied`), built by construction with no oracle re-implementing the matcher; include `<shell> script.sh` without a pipe returning `undefined`
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9**

- [x] 21. Documentation
  - [x] 21.1 Add one line to `docs/SANDBOX.md`
    - State that the deny list is best-effort and that the dedicated low-limit key is the real control
    - _Requirements: 14.10_

- [x] 22. Final checkpoint - Run typecheck and tests at the repository root
  - Run `pnpm typecheck` at the repository root and fix any errors
  - Run `pnpm test` at the repository root and fix any failures; use fakes only
  - Confirm `apps/web/next-env.d.ts` is untouched (revert any change a build made to it)
  - Both commands must exit with code 0; ask the user if questions arise.
  - _Requirements: 14.11_

- [x] 23. Deploy helpers and scripts for API-key-only hosts
  - [x] 23.1 Create `deploy/env-value.sh` with `env_value` and `sync_refresh_timer`
    - POSIX `sh`; `env_value NAME FILE` reads line by line with `IFS= read -r`, keeps the value of the last line starting with `NAME=`, strips one pair of surrounding `"` or `'`, prints nothing for a blank value, returns 0 for a missing or unreadable file; no `source`, `eval` or expansion of file content
    - `sync_refresh_timer` (uses `log` and `ENV_FILE` of the caller): enable `seance-kiro-refresh.timer` with `systemctl enable --now` when `SEANCE_SANDBOX_AUTH_DIR` is non-blank, otherwise log one line and run `systemctl disable --now seance-kiro-refresh.timer || true`
    - Keep the file clean under `shellcheck --severity=style deploy/*.sh`
    - _Requirements: 15.4, 15.5, 15.9, 15.10, 15.12, 15.28_
  - [x] 23.2 Change `deploy/bootstrap.sh`: credential gate and conditional timer
    - Source `deploy/env-value.sh`; add `kiro_credential_ok` called by `ready_for_agents`: with a Host_Key, `printf '%s\n' "$key" | as_seance sh -c 'IFS= read -r KIRO_API_KEY || exit 1; export KIRO_API_KEY; exec kiro-cli whoami' >/dev/null 2>&1`; without one, `as_seance kiro-cli whoami`
    - Key stays out of every argv, stdout, stderr, the bootstrap log and any trace; `key` is a non-exported local; no `set -x`, `bash -x` or `xtrace`
    - Failure NEXT STEP: without a key it names both the `kiro-cli login --use-device-flow` login and `KIRO_API_KEY`; with a key it names `KIRO_API_KEY` and `/etc/seance/seance.env` without the value
    - Replace both direct `seance-kiro-refresh.timer` enables with `sync_refresh_timer`; split the combined `systemctl enable --now` line into `seance-sandbox-nft.service seance-egress-refresh.timer` and then `sync_refresh_timer`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.12_
  - [x] 23.3 Change `deploy/update.sh`: conditional timer
    - Add `ENV_FILE=/etc/seance/seance.env`, source `deploy/env-value.sh`, and replace the `systemctl enable --now seance-kiro-refresh.timer` in the `AGENTS_WERE_ACTIVE` branch with `sync_refresh_timer`
    - _Requirements: 15.11, 15.12_
  - [x] 23.4 Make `deploy/seance-kiro-refresh.sh` exit early without an Auth_Dir and update the service unit
    - Before the user check and before any file access: if `SEANCE_SANDBOX_AUTH_DIR` is unset or blank, read it from `${SEANCE_ENV_FILE:-/etc/seance/seance.env}` with an inline copy of `env_value` (identical text to `deploy/env-value.sh`, no `local`, no `[[ ]]`); if still blank, log exactly one `seance-kiro-refresh:` line and `exit 0` without touching `mktemp`, `flock` or any login file
    - Add `EnvironmentFile=-/etc/seance/seance.env` to `deploy/systemd/seance-kiro-refresh.service`; no `Environment=` line with `KIRO_API_KEY`
    - _Requirements: 15.12, 15.13, 15.14, 15.15_
  - [x] 23.5 Change `deploy/systemd/seance-ircd.service`
    - Remove `ConditionDirectoryNotEmpty=`; add an `ExecStartPre=/bin/sh -c 'case "$$SEANCE_SANDBOX_AUTH_DIR" in *[![:space:]]*) [ -n "$$(ls -A -- "$$SEANCE_SANDBOX_AUTH_DIR" 2>/dev/null)" ] ;; esac'` before `ExecStart`
    - Add a comment that `bootstrap.sh` and the Runner at start (Requirement 4, criterion 1) check the credential
    - _Requirements: 15.16, 15.17, 15.18_
  - [x] 23.6 Confirm `env-value.sh` reaches the host and update `deploy/seance.env.example`
    - Check the install steps in `bootstrap.sh` (`install_units`, near L427-435) and `update.sh` (near L74-76): both scripts run from `/opt/seance/deploy` and source `env-value.sh` from the checked-out repo, so no extra copy is needed; add one only if a step copies scripts elsewhere
    - In `deploy/seance.env.example` keep `SEANCE_SANDBOX_AUTH_DIR` uncommented and change its comment: optional when `KIRO_API_KEY` is set, enables the login refresh timer, delete or blank it for a key-only host; keep `KIRO_API_KEY` as a commented placeholder
    - _Requirements: 15.12, 15.22_
- [x] 24. Tests and lint for the deploy changes
  - [x] 24.1 Update and extend `apps/runner/test/sandbox-files.test.ts`
    - Static: `bootstrap.sh` passes the key via `IFS= read -r KIRO_API_KEY` and `exec kiro-cli whoami`; no line combines `KIRO_API_KEY=` plus an expansion with `sudo`, `su`, `runuser` or `env`; no `set -x`, `bash -x` or `xtrace`; both scripts call `sync_refresh_timer`, contain `systemctl disable --now seance-kiro-refresh.timer`, and enable the timer only inside the guarded branch; rewrite the existing assertions on the number and position of the timer enable lines (around L287-L300) to the new structure; the ircd unit has no `ConditionDirectoryNotEmpty=` and has the `ExecStartPre=` and comment; the refresh service has no `KIRO_API_KEY` in an `Environment=` line; `docs/DEPLOY.md` section 5 and `deploy/seance.env.example` hold the statements of 15.19, 15.20, 15.22
    - Executable: the refresh script with `SEANCE_SANDBOX_AUTH_DIR` unset and blank, `HOME` in an empty temp dir, `SEANCE_ENV_FILE` pointing at a missing file: exit 0, one `seance-kiro-refresh:` line, temp `HOME` unchanged; the `ExecStartPre` string (with `$$` turned into `$`) with an unset variable, a blank one, an empty directory and a directory with an entry gives 0, 0, non-zero, 0
    - Assert the inline `env_value` text in `seance-kiro-refresh.sh` is identical to the one in `deploy/env-value.sh`
    - _Requirements: 15.15, 15.16, 15.17, 15.18, 15.23, 15.25, 15.26, 15.27_
  - [x] 24.2 Write the Property 19 test (`env_value`) in `apps/runner/test/sandbox-files.test.ts`
    - **Property 19: env_value reads the last uncommented assignment, quotes stripped, blank is unset**
    - fast-check, at least 100 runs, `sh` child process on a temp file; generated lines include comments, blanks, other names and bare, double-quoted and single-quoted values with `$`, backticks, `;` and spaces; assert last value wins, blank gives empty output, nothing is executed, exit 0
    - **Validates: Requirements 15.4, 15.5, 15.12**
  - [x] 24.3 Write the Property 20 test (credential gate keeps the key out of argv, output and trace) in `apps/runner/test/sandbox-files.test.ts`
    - **Property 20: The credential check keeps the key out of argv, output and trace**
    - fast-check, at least 100 runs; extract `env_value`, `kiro_credential_ok` and a stubbed `as_seance` (fake `runuser` dropping arguments up to `--`) with fake `kiro-cli`, `sudo`, `runuser` and `systemctl` on `PATH` recording argv; run the child with `bash -x` and capture stdout and stderr; assert the key is absent from every recorded argv and from the captured output, and the fake `kiro-cli` sees `KIRO_API_KEY` exactly, including leading and trailing spaces; no real `kiro-cli` and no systemd
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.6, 15.24**
  - [x] 24.4 Run `shellcheck --severity=style deploy/*.sh`
    - Run it if `shellcheck` is installed and fix findings in the changed scripts; if it is not installed, report that it was not run and that the CI step remains the check
    - _Requirements: 15.28, 15.29_
- [x] 25. Documentation
  - [x] 25.1 Add the API-key path to `docs/DEPLOY.md` section 5
    - Set `KIRO_API_KEY` in `/etc/seance/seance.env`, leave `SEANCE_SANDBOX_AUTH_DIR` unset, run no `kiro-cli login`, expect no `seance-kiro-refresh.timer`, and the ircd starts
    - State that `bootstrap.sh` checks the key with `kiro-cli whoami` as `seance` and that the key does not appear in the argv of that check
    - State that switching from a login to the key means unsetting `SEANCE_SANDBOX_AUTH_DIR` and running `sudo /opt/seance/deploy/bootstrap.sh` again, which disables the refresh timer, and that teardown (section 9) still disables the timer first
    - _Requirements: 15.19, 15.20, 15.21_
- [x] 26. Final checkpoint - Run typecheck and tests at the repository root
  - Run `pnpm typecheck` at the repository root and fix any errors
  - Run `pnpm test` at the repository root and fix any failures; use fakes only
  - Confirm `apps/web/next-env.d.ts` is untouched (revert any change a build made to it)
  - Both commands must exit with code 0; ask the user if questions arise.
  - _Requirements: 15.30_
## Notes

- All test sub-tasks are required in this follow-up, including property tests
- Tasks 1 to 6 are implemented; 3.2 and 3.6 are adjusted because `redactSpawnSpec` is removed (task 10)
- Each task references specific requirements for traceability
- Property tests validate the universal correctness properties from the design; examples cover specific cases
- Never log, echo or commit a real key; tests use generated placeholder values

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["23.1", "23.4", "23.5", "23.6", "25.1"] },
    { "id": 1, "tasks": ["23.2", "23.3"] },
    { "id": 2, "tasks": ["24.1"] },
    { "id": 3, "tasks": ["24.2"] },
    { "id": 4, "tasks": ["24.3"] },
    { "id": 5, "tasks": ["24.4"] }
  ]
}
```
