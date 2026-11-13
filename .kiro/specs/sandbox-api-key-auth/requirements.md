# Requirements Document

## Introduction

In podman sandbox mode the Runner authenticates Kiro only through a read-only mount of a kiro-cli login directory (`SEANCE_SANDBOX_AUTH_DIR`), and it deliberately drops `KIRO_API_KEY`. A login session expires and needs an interactive browser login, which is not available while judges use the live app through January 29, 2027.

This feature lets the sandboxed `kiro-cli acp` authenticate with `KIRO_API_KEY` instead. Verified with kiro-cli 3.2.1, empty HOME and no login: `kiro-cli acp` starts with only `KIRO_API_KEY` in its environment on both engines; on the v2 engine (the Runner uses `--agent`) `session/new` and `session/prompt` succeed and `_kiro.dev/metadata` still carries `meteringUsage`, so the credits counter keeps working. Per the Kiro documentation, a browser or CLI login takes precedence over `KIRO_API_KEY` when both exist.

The Runner already forwards the key in local mode (`apps/runner/src/harness/spawn.ts`, `apps/runner/src/config.ts`). This feature covers podman mode: `apps/runner/src/sandbox/podman-args.ts`, `apps/runner/src/sandbox/launcher.ts`, and the podman-mode parsing in `apps/runner/src/config.ts`. The Runner launches each agent container with a single `podman run`; no `podman exec` is used for `kiro-cli acp`.

Security rule: the key value never appears in any podman argument vector (visible through `ps`, shell history or logs). The container receives it through a name-only `--env KIRO_API_KEY` flag, and the value travels in the environment of the spawned podman process.

## Glossary

- **Runner**: The `apps/runner` process that launches agent containers and speaks ACP to them.
- **Config_Loader**: The Runner code that reads environment variables into `RunnerConfig` (`loadRunnerConfig` and `parseSandbox` in `apps/runner/src/config.ts`).
- **Podman_Args_Builder**: The pure function `buildPodmanRunArgs` in `apps/runner/src/sandbox/podman-args.ts`, which produces the argv after the podman binary.
- **Launcher**: The `PodmanLauncher` class in `apps/runner/src/sandbox/launcher.ts`, which builds the spawn spec and the podman process environment.
- **Spawn_Spec**: The `SandboxSpec` returned by `Launcher.spec`: `command`, `args`, `cwd`, `env` and `containerName`.
- **Podman_Process_Env**: The `env` field of the Spawn_Spec and of every podman invocation made by the Launcher.
- **Api_Key**: The value of the environment variable `KIRO_API_KEY`. An empty or whitespace-only value counts as unset (Requirement 9).
- **Whitespace**: A space, a tab, or any other Unicode whitespace character.
- **Auth_Dir**: The directory named by `SEANCE_SANDBOX_AUTH_DIR`, holding the kiro-cli login state. An empty or whitespace-only value counts as unset.
- **Auth_Mount**: The read-only `--mount` of the Auth_Dir at the container auth mount point.
- **Key_Forward_Flag**: The two argv elements `-e` and `KIRO_API_KEY` (name only, no `=` and no value).
- **Agent_Container**: The rootless podman container in which `kiro-cli acp --agent <name>` runs.
- **Probe_Container**: The network-isolation check container built by `buildProbeArgs`.
- **Redactor**: The Runner code that removes known secret values from logs, notices and agent output.
- **Key_Reader_Command**: A shell command text that can reveal the Api_Key from inside the Agent_Container: the `env`, `printenv` or `export` commands (including `export -p`, `declare -x` and `set` with no arguments), or any reference to `/proc/<pid>/environ` (`/proc/self/environ`, `/proc/*/environ`, `/proc/<digits>/environ`, including quoted, backslash-escaped or globbed forms), or a reference to the variable `KIRO_API_KEY` by name (for example `$KIRO_API_KEY`, `${KIRO_API_KEY}`).
- **Environ_Path**: A resolved tool path that is `/proc/environ`-like: a path whose segments are `proc`, then `self`, `thread-self` or digits or `*`, then `environ`.
- **Deny_List**: `matchDenyList`, `referencesAuthPath` and `isAuthPath` in `apps/runner/src/permissions/deny-list.ts`, applied by `decide` in `apps/runner/src/permissions/policy.ts`.
- **Secret_Redactor**: The `SecretRedactor` class in `apps/runner/src/output/secret-redactor.ts`, built in `apps/runner/src/runner.ts` from `config.kiroApiKey` and the login-dir secrets, and shared by every agent output path.
- **Key_Variants**: The raw Api_Key plus its base64 (padded and unpadded), base64url (padded and unpadded) and hex (lower and upper case) encodings, as produced by `variantsOf`.
- **Sandbox_Docs**: `README.md` (runner configuration table and Secrets section), `DESIGN.md` (harness section near line 190), `docs/SANDBOX.md`, and `deploy/seance.env.example`.

## Requirements

### Requirement 1: Forward the API key into the Agent_Container

**User Story:** As an operator of the live app, I want the sandboxed Kiro to authenticate with `KIRO_API_KEY`, so that agents keep working without an interactive login session.

#### Acceptance Criteria

1. WHILE the sandbox mode is `podman` and the Api_Key is set, THE Podman_Args_Builder SHALL include the Key_Forward_Flag exactly once in the `podman run` argv, before the image argument.
2. WHILE the sandbox mode is `podman` and the Api_Key is set, THE Launcher SHALL set `KIRO_API_KEY` to the Api_Key in the Podman_Process_Env of the Spawn_Spec.
3. WHILE the sandbox mode is `podman` and the Api_Key is not set, THE Podman_Args_Builder SHALL omit the Key_Forward_Flag and THE Launcher SHALL NOT set `KIRO_API_KEY` in the Podman_Process_Env.
4. THE Launcher SHALL NOT use `podman exec` to start `kiro-cli acp`.
5. WHILE the sandbox mode is `podman`, THE Launcher SHALL NOT pass `KIRO_API_KEY` in the environment of any podman invocation other than the Agent_Container `podman run`, including `--version`, `info`, `image exists`, `stop`, `rm`, `ps` and the Probe_Container `run`.
6. IF the generic `forwardEnv` list contains `KIRO_API_KEY`, THEN THE Podman_Args_Builder SHALL reject it with an error, so that the key can only travel through the dedicated Api_Key input.

### Requirement 2: Keep the key value out of argv, logs and output

**User Story:** As a security-conscious operator, I want the key value to stay out of process listings and logs, so that a leaked `ps` output or log file does not reveal the credential.

#### Acceptance Criteria

1. THE Podman_Args_Builder SHALL produce an argv in which no element contains the Api_Key as a substring, for every Api_Key value that is a non-empty string without NUL, CR or LF.
2. THE Podman_Args_Builder SHALL emit the key only as the name `KIRO_API_KEY`, never in the form `KIRO_API_KEY=<value>`.
3. THE Launcher SHALL NOT write the Api_Key to any log record, error message or `SandboxError` detail.
4. THE Runner SHALL NOT write a Spawn_Spec, a Podman_Process_Env or a podman argv to any log record, and the unused `redactSpawnSpec` function in `apps/runner/src/sandbox/launcher.ts` SHALL be removed together with its tests (superseded by Requirement 10, criterion 1).
5. THE Redactor SHALL remove the Api_Key from every agent output text, as it does in local mode.
6. IF the Api_Key contains a NUL, CR or LF character, THEN THE Config_Loader SHALL fail startup with a `ConfigError` that names `KIRO_API_KEY` and does not include the value.

### Requirement 3: Mount the Auth_Dir only when it is set

**User Story:** As an operator using an API key, I want to run without a login directory, so that no stale or missing login state blocks startup.

#### Acceptance Criteria

1. WHILE the Auth_Dir is set, THE Podman_Args_Builder SHALL include the Auth_Mount exactly once.
2. WHILE the Auth_Dir is not set, THE Podman_Args_Builder SHALL omit the Auth_Mount and SHALL NOT validate or resolve any auth path.
3. WHILE the Auth_Dir is set, THE Config_Loader SHALL keep the existing checks that the Auth_Dir is mount-safe, is an existing directory, and is resolved to its real path.
4. WHILE the Auth_Dir is not set, THE Launcher preflight SHALL skip the auth directory existence check and SHALL still run the version, rootless, image and Probe_Container checks.
5. WHILE the Auth_Dir is not set, THE Launcher SHALL NOT pass an auth path to mount path resolution, so that the mount path overlap and containment checks cover only the remaining mounts.

### Requirement 4: Validate sandbox authentication at startup

**User Story:** As an operator, I want a clear startup error when no Kiro credential is configured, so that I find the problem at boot rather than at the first invite.

#### Acceptance Criteria

1. IF the sandbox mode is `podman` and neither the Auth_Dir nor the Api_Key is set, THEN THE Config_Loader SHALL fail startup with a `ConfigError` that names both `SEANCE_SANDBOX_AUTH_DIR` and `KIRO_API_KEY` and states that one of them is required.
2. WHEN the sandbox mode is `podman` and only the Api_Key is set, THE Config_Loader SHALL accept the configuration.
3. WHEN the sandbox mode is `podman` and only the Auth_Dir is set, THE Config_Loader SHALL accept the configuration and keep the current behavior.
4. WHEN the sandbox mode is `podman` and both the Auth_Dir and the Api_Key are set, THE Config_Loader SHALL accept the configuration and THE Podman_Args_Builder SHALL include both the Auth_Mount and the Key_Forward_Flag.
5. WHEN the sandbox mode is `podman` and both the Auth_Dir and the Api_Key are set, THE Runner SHALL log exactly one startup warning that names `KIRO_API_KEY` and `SEANCE_SANDBOX_AUTH_DIR`, states that the login takes precedence over the Api_Key, and does not contain the Api_Key value.
6. WHILE the sandbox mode is `podman`, THE Config_Loader SHALL NOT report `KIRO_API_KEY` as an ignored variable.
7. WHILE the sandbox mode is `none`, THE Config_Loader SHALL keep the current Api_Key handling unchanged.

### Requirement 5: Preserve existing sandbox guarantees

**User Story:** As a maintainer, I want the new auth path to leave the isolation rules intact, so that adding a credential does not weaken the sandbox.

#### Acceptance Criteria

1. WHILE the Api_Key is not set, THE Podman_Args_Builder SHALL emit every existing fixed flag unchanged and in the existing order.
2. THE Podman_Args_Builder SHALL emit the Key_Forward_Flag only as a separate `-e` and name pair, consistent with the existing forwarded variables.
3. THE Probe_Container argv and Podman_Process_Env SHALL NOT contain the Api_Key.
4. WHILE the Auth_Dir is not set, THE Redactor SHALL remove the Api_Key from agent output.

### Requirement 6: Update the documentation

**User Story:** As an operator or judge reading the repo, I want accurate auth documentation, so that I can configure the sandbox correctly.

#### Acceptance Criteria

1. THE Sandbox_Docs SHALL describe `KIRO_API_KEY` in podman mode as forwarded by name with the value carried in the podman process environment.
2. THE Sandbox_Docs SHALL describe `SEANCE_SANDBOX_AUTH_DIR` as optional when `KIRO_API_KEY` is set and required otherwise.
3. THE Sandbox_Docs SHALL state that a login takes precedence over `KIRO_API_KEY` when both are present.
4. THE Sandbox_Docs SHALL contain no statement that `KIRO_API_KEY` is never forwarded in podman mode.
5. THE Sandbox_Docs SHALL state that the Api_Key is readable inside the Agent_Container and recommend a dedicated key that is used nowhere else, is bounded by Séance's own credit caps, and is revoked after January 29, 2027.
6. THE Sandbox_Docs SHALL list `KIRO_API_KEY` in `deploy/seance.env.example` as a placeholder without a real value.
7. THE `DESIGN.md` harness section SHALL describe the podman-mode key handling: name-only forwarding, the value in the podman process environment, and login precedence.

### Requirement 7: Automated test coverage

**User Story:** As a maintainer, I want tests for the new behavior, so that regressions in the key handling are caught before deployment.

#### Acceptance Criteria

1. THE test suite SHALL contain a unit test in `apps/runner/test/podman-args.test.ts` asserting that the Key_Forward_Flag is present, name-only, when the Api_Key is set, and absent when it is not.
2. THE test suite SHALL contain a unit test asserting that the Auth_Mount is absent when the Auth_Dir is unset and present when it is set.
3. THE test suite SHALL contain a Launcher test, using a fake `PodmanExec`, asserting that the Podman_Process_Env of the Spawn_Spec holds the Api_Key and that the argv does not.
4. THE test suite SHALL contain a Launcher test asserting that no podman invocation other than the Agent_Container `run` receives `KIRO_API_KEY` in its environment.
5. THE test suite SHALL contain a fast-check property named `P1 key never in argv`, with generated Api_Key values that include multi-byte UTF-8 characters, asserting that no argv element contains the Api_Key and that the argv equals the argv built without the key plus exactly one Key_Forward_Flag.
6. THE test suite SHALL contain tests in `apps/runner/test/sandbox-config.test.ts` for: neither credential set (error naming both variables, value absent), only the Api_Key, only the Auth_Dir, both set (accepted, warning logged), and a rejected Api_Key containing CR or LF.
7. (Superseded by Requirement 10, criterion 1: no test of `redactSpawnSpec` remains once the function is removed.)
8. THE test suite SHALL use fakes and SHALL NOT start a real `podman` or `kiro-cli` process.
9. WHEN `pnpm typecheck` and `pnpm test` run at the repository root, THE Runner packages SHALL pass both with exit code 0, and `apps/web/next-env.d.ts` SHALL remain unmodified.

### Requirement 8: Keep the key unreadable and unspeakable for the agent

**User Story:** As a security-conscious operator, I want the agent's shell and its output to be unable to reveal the key, so that a prompt-injected agent cannot leak `KIRO_API_KEY` to the channel.

#### Acceptance Criteria

1. WHEN a shell tool command is a Key_Reader_Command, THE Deny_List SHALL reject it with the reason `protected-path`, in the same way `referencesAuthPath` rejects the Kiro login.
2. THE Deny_List SHALL evaluate the Key_Reader_Command check after removing quotes and backslashes from the command and lower-casing it, and SHALL detect the command name in any simple command of a pipeline, list or substitution, including when called through a path (`/usr/bin/env`) or after `command`, `exec`, `sudo` or `xargs`.
3. WHEN a tool path (read, write or other file tool) is an Environ_Path, either as raw text or after resolution, THE `decide` function SHALL reject it with the reason `protected-path`, for every policy mode including `op`.
4. WHEN a shell tool command invokes `env` with a command operand (the first argument that is neither an option nor a `NAME=value` assignment, for example `env FOO=1 git status`), THE Deny_List SHALL accept the command.
5. WHILE the Api_Key is set, THE Runner SHALL construct the Secret_Redactor with the Api_Key.
6. THE Secret_Redactor SHALL remove every Key_Variants form of the Api_Key, and every 8-character fragment of each variant, from agent output text.
7. WHILE the Api_Key is shorter than 8 characters, THE Secret_Redactor SHALL remove only whole occurrences of it and SHALL NOT remove fragments of it.
8. THE Runner SHALL pass the same Secret_Redactor instance that holds the Api_Key to every agent output path (channel text, AWAY text, whois text and tool notices), so that no path redacts only the raw key.
9. THE Sandbox_Docs SHALL state that the Deny_List and the Secret_Redactor match text only, so an agent can still read the Api_Key by means they do not match (for example a script or an unlisted encoding), which is why a dedicated key bounded by Séance's own credit caps is required (Requirement 11).

### Requirement 9: Treat a whitespace-only key as unset

**User Story:** As an operator, I want a blank `KIRO_API_KEY` line in the env file to count as no key, so that a stray space neither passes the credential check nor sends an unusable key.

#### Acceptance Criteria

1. IF `KIRO_API_KEY` is empty or contains only Whitespace, THEN THE Config_Loader SHALL set `kiroApiKey` to `undefined`.
2. IF the sandbox mode is `podman`, `SEANCE_SANDBOX_AUTH_DIR` is not set and `KIRO_API_KEY` is whitespace-only, THEN THE Config_Loader SHALL fail startup with the `ConfigError` of Requirement 4, criterion 1.
3. IF `KIRO_API_KEY` has a non-whitespace value with leading or trailing whitespace, THEN THE Config_Loader SHALL keep the value unchanged.
4. THE Config_Loader SHALL check the NUL, CR and LF rule of Requirement 2, criterion 6 before the whitespace-only check, so that a value such as `" \n"` still fails with the `ConfigError` naming `KIRO_API_KEY`.
5. WHILE the sandbox mode is `none`, THE Config_Loader SHALL apply the same whitespace-only rule, so that local mode does not forward a blank key (this refines Requirement 4, criterion 7 for blank values only).
6. THE `sandboxAuthWarnings` function and `buildSpawnSpec` SHALL treat `kiroApiKey` as set only when it is a non-empty string.

### Requirement 10: Housekeeping and contract updates

**User Story:** As a maintainer, I want the leftover code, tests and old decisions to match the shipped behavior, so that nothing contradicts the key forwarding.

#### Acceptance Criteria

1. THE file `launcher.ts` SHALL NOT define or export `redactSpawnSpec`, and `sandbox-api-key.test.ts` SHALL NOT test it.
2. THE file `sandbox-api-key.test.ts` SHALL contain no unreferenced import, and `pnpm typecheck` SHALL pass.
3. THE integration test `apps/ircd/test/runner/sandbox.integration.test.ts` SHALL replace the expectation `KIRO_API_KEY=<unset>` with the new contract: WHEN the Runner has an Api_Key, THE agent process inside the Agent_Container SHALL see `KIRO_API_KEY` set, and THE test output SHALL show only a set/unset marker, never the value; `SEANCE_SECRET_CANARY` SHALL still be `<unset>`.
4. THE integration test title and probe label SHALL name `KIRO_API_KEY` and print only the marker `set` or `<unset>`, and the test SHALL continue to skip itself when podman is unavailable.
5. THE file `docs/DEPLOY.md` section 5 SHALL contain no statement that the host has no `KIRO_API_KEY`, and SHALL state that the login is the default and `KIRO_API_KEY` is the documented alternative.
6. THE file `.kiro/specs/agent-sandbox/design.md` SHALL mark decision D18 (and its references in D10, the `authDir` comment, the mount section and the credential-exposure risk) as superseded by `sandbox-api-key-auth`, keeping the original text visible.
7. THE file `.kiro/specs/agent-sandbox/requirements.md` SHALL mark criterion 4 of the configuration requirement (the line stating that `KIRO_API_KEY` does not count as a credential source in podman mode) as superseded by `sandbox-api-key-auth` Requirements 1 and 4, keeping the original text visible.
8. WHEN `pnpm typecheck` and `pnpm test` run at the repository root after these changes, THE Runner packages and `apps/ircd` SHALL pass both with exit code 0, and `apps/web/next-env.d.ts` SHALL remain unmodified.

### Requirement 11: Recommend a dedicated, revocable key, bounded by Séance's credit caps, for public deployments

**User Story:** As an operator of a public deployment, I want clear guidance on the key to use, so that a leaked key costs little and can be replaced fast.

#### Acceptance Criteria

1. THE Sandbox_Docs SHALL recommend that a public deployment use a Kiro API key created only for the Séance host, used nowhere else.
2. THE Sandbox_Docs SHALL state that Kiro API keys have no per-key spend limit and that the cost is bounded by the Séance credit caps (`SEANCE_DAILY_CREDIT_CAP=100`, `SEANCE_CHANNEL_CREDIT_CAP=30`), and SHALL state that those caps count spend made through Séance and do not limit a leaked key used elsewhere. (Recorded follow-up of 2026-11-13: this replaces the earlier criterion that recommended a usage limit on the key, which Kiro does not offer.)
3. THE Sandbox_Docs SHALL describe how to rotate the key: create the new key, replace `KIRO_API_KEY` in `/etc/seance/seance.env`, restart the Runner, and revoke the old key; and SHALL recommend rotating it after any suspected exposure and revoking it after January 29, 2027.
4. THE Sandbox_Docs SHALL state that a personal account login should not be used on a public host when a dedicated key is available.
5. THE Sandbox_Docs SHALL state that the Api_Key is readable by the agent inside the Agent_Container (Requirement 8, criterion 9) and that the egress allow-list limits where a leaked value could be sent.
6. THE Sandbox_Docs SHALL cover this guidance in `docs/SANDBOX.md` and `docs/DEPLOY.md`, and `README.md` and `deploy/seance.env.example` SHALL point to it in one line each.

### Requirement 12: Test coverage for the follow-up

**User Story:** As a maintainer, I want tests for the follow-up behavior, so that the key cannot be reintroduced into reachable places.

#### Acceptance Criteria

1. THE test suite SHALL contain unit tests that `matchDenyList` rejects `env`, `printenv`, `printenv KIRO_API_KEY`, `cat /proc/self/environ`, `cat /proc/1/environ`, `cat /proc/*/environ`, `tr '\0' '\n' < /proc/self/environ`, `echo $KIRO_API_KEY`, `/usr/bin/env | grep KIRO` and `ls; env`, and accepts `env FOO=1 git status`, `git status` and `cat /proc/cpuinfo`.
2. THE test suite SHALL contain a `decide` test that an Environ_Path is rejected with `protected-path` in `op` mode for a read tool.
3. THE test suite SHALL contain a fast-check property that, for generated Api_Key values of at least 8 characters and run for at least 100 generated cases, the Secret_Redactor output for text containing any Key_Variants form does not contain that form.
4. THE test suite SHALL contain a test that the Runner builds its Secret_Redactor with the Api_Key (a base64 form of the configured key is removed from agent output).
5. THE test suite SHALL contain config tests for a whitespace-only `KIRO_API_KEY` in `podman` mode with and without `SEANCE_SANDBOX_AUTH_DIR`, in `none` mode, and for a value with surrounding whitespace that is kept unchanged.
6. THE test suite SHALL use fakes and SHALL NOT start a real `podman` or `kiro-cli` process, except for the existing integration test that skips itself when podman is unavailable.

### Requirement 13: Close known deny-list gaps and document the remaining exposure

**User Story:** As a security-conscious operator, I want the known Deny_List bypasses closed and the remaining exposure written down, so that I rely on the dedicated, low-limit key rather than on the text filter.

The terms below extend the Glossary for this requirement.

- **Shell_Name**: One of `sh`, `bash`, `zsh`, `dash`, `ksh`, `ash`, compared by base name and lower-cased.
- **C_Option_Group**: A word that starts with a single `-`, is followed by letters only, and contains the letter `c` (for example `-c`, `-lc`, `-ec`).
- **Command_Word**: The first word of a simple command after leading `NAME=value` assignments and after the wrappers `command`, `exec`, `sudo`, `xargs`, `nohup`, `time` and `builtin` with their options, and, when that word is `env`, after the `env` options and assignments up to its command operand.
- **C_Script**: The word that follows the C_Option_Group, taken with quotes honoured.
- **Nesting_Depth**: The number of C_Script levels entered by the key-reader check; the top-level command has depth 0.
- **Environ_Glob**: A path segment that contains `*`, `?` or `[` and that `globMatches` reports as matching `environ`.

#### Acceptance Criteria

1. WHEN the Command_Word of a simple command is a Shell_Name invoked with a C_Option_Group, THE Deny_List SHALL apply the Key_Reader_Command check recursively to the C_Script, up to a Nesting_Depth of 4.
2. IF the Nesting_Depth of a C_Script exceeds 4, THEN THE Deny_List SHALL reject the command with the reason `protected-path`.
3. THE Deny_List SHALL reject with the reason `protected-path` each of `sh -c env`, `bash -c printenv`, `env sh -c env`, `bash -lc "export -p"` and `sh -c "sh -c \"sh -c env\""`.
4. THE Deny_List SHALL accept `sh -c "git status"` and `bash -c "env FOO=1 git status"`.
5. WHEN `env` has a command operand, THE Deny_List SHALL apply the Key_Reader_Command check to that operand and its arguments as a simple command, so that `env printenv` is rejected with the reason `protected-path` and `env FOO=1 git status` is still accepted (this refines Requirement 8, criterion 4, which stays valid for operands that are not Key_Reader_Commands).
6. IF a shell command contains `/proc` and any path segment of the command is an Environ_Glob, THEN THE Deny_List SHALL reject the command with the reason `protected-path`, including `cat /proc/self/envi*`, `cat /proc/self/env?ron`, `cat /proc/self/*` and `cat /proc/self/[e]nviron`.
7. WHEN the last segment of a tool path is an Environ_Glob and a segment named `proc` precedes it, THE `isEnvironPath` function SHALL return true, so that `decide` rejects the path as an Environ_Path under Requirement 8, criterion 3.
8. THE test suite SHALL contain `matchDenyList` and `isEnvironPath` unit tests for every example in criteria 3 to 7, including the depth-5 rejection and one accepted `/proc` command that has no Environ_Glob (`cat /proc/cpuinfo`).
9. THE test suite SHALL contain a Runner-level test that drives a real Runner with a fake agent whose output contains the raw Api_Key and its base64 form on each agent output path: channel messages (agent text), tool-call notices or tool output shown on IRC, and error or notice text.
10. WHEN the Runner-level test of criterion 9 runs, THE Secret_Redactor SHALL ensure that no IRC line sent by the Runner on any path listed in criterion 9 contains the raw Api_Key or its base64 form, and the test SHALL fail if any such line does.
11. THE `docs/SANDBOX.md` and `docs/DEPLOY.md` files SHALL state that `podman inspect` of a running Agent_Container and the host file `/proc/<pid>/environ` of the podman process expose the Api_Key to the `seance` user and to root.
12. THE `docs/SANDBOX.md` and `docs/DEPLOY.md` files SHALL list the remaining text-deny-list limits: `python -c`, `node -e`, `awk` with `ENVIRON`, `perl`, other encodings of the Api_Key, and variable or file names built at run time by string concatenation or command substitution.
13. THE `docs/SANDBOX.md` and `docs/DEPLOY.md` files SHALL state that a dedicated, revocable key bounded by Séance's credit caps (Requirement 11) is the main mitigation.
14. THE file `.kiro/specs/deploy-aws/design.md` SHALL mark decision D7 (the statement "No `KIRO_API_KEY` on the host") as superseded by `sandbox-api-key-auth`, keeping the original text visible.
15. THE file `.kiro/specs/deploy-aws/requirements.md` SHALL mark criterion 1 of the Kiro login requirement (the line beginning "`KIRO_API_KEY` SHALL NOT be used", line 69) as superseded by `sandbox-api-key-auth` Requirements 1, 4 and 10, keeping the original text visible.
16. WHEN `pnpm typecheck` and `pnpm test` run at the repository root with the Requirement 13 changes applied, THE `apps/runner` and `apps/ircd` projects SHALL pass both with exit code 0.
17. THE Requirement 13 changes SHALL NOT modify `apps/web/next-env.d.ts`.

### Requirement 14: Final deny-list hardening

**User Story:** As a security-conscious operator, I want the last known textual bypasses of the Deny_List closed, so that the text filter stops the common ways an agent could print the Api_Key and I can state plainly that the dedicated key is the real control.

The terms below extend the Glossary for this requirement. In `apps/runner/src/permissions/deny-list.ts`, `SCRIPT_SHELLS` (`sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `ash`, `fish`) is the Shell_Name list of this requirement, `MAX_SCRIPT_DEPTH` is 4, and `KEY_READER_WRAPPERS` (`command`, `exec`, `sudo`, `xargs`, `nohup`, `time`, `builtin`) is the wrapper list. The wrapper-skipping loop in `isKeyReaderWords` currently skips every word that starts with `-` after a wrapper, without skipping option values.

- **Shell_Name**: As in Requirement 13, extended to `sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `ash` and `fish`, compared by base name and lower-cased.
- **Script_File_Operand**: A word of a Shell_Name command that follows its options and does not start with `-`.
- **Stdin_Script_Source**: A pipe into the simple command (the simple command follows a `|` in the command text), a here-string (`<<<`) or a here-document (`<<`) attached to the simple command.
- **Wrapper_Option_Value**: The separate argument consumed by a wrapper option, as listed in criterion 5.
- **Proc_Glob**: A path segment that contains `*`, `?` or `[`, that `globMatches` reports as matching `proc`, and that precedes a later segment that matches `environ` literally or as an Environ_Glob.

#### Acceptance Criteria

1. WHEN the Command_Word of a simple command is `eval`, THE Deny_List SHALL join the words after `eval` with single spaces and apply the Key_Reader_Command check to the joined text at Nesting_Depth plus 1.
2. IF the Nesting_Depth exceeds 4 (the limit of Requirement 13, criterion 2), THEN THE Deny_List SHALL reject the command with the reason `protected-path`.
3. WHEN the command is `eval env`, `eval "printenv HOME"` or `eval 'sh -c env'`, THE Deny_List SHALL reject it with the reason `protected-path`.
4. IF the Command_Word of a simple command is a Shell_Name, the simple command has no C_Option_Group and no Script_File_Operand, and the simple command has a Stdin_Script_Source, THEN THE Deny_List SHALL reject the command with the reason `protected-path` without inspecting the script text. THE Deny_List SHALL reject `echo env | sh`, `printf 'env' | bash`, `bash <<< env` and `cat x | bash -s` with the reason `protected-path`, and SHALL accept `sh script.sh`, `bash -c "git status"` and `git log | sort`.
5. WHEN the Deny_List scans the words after a wrapper in a simple command, THE Deny_List SHALL skip the Wrapper_Option_Value of each option that takes one, before looking for the Command_Word, as follows: for `sudo` the short options `-u`, `-g`, `-C`, `-D`, `-h`, `-p`, `-r`, `-t`, `-U` and `-T`, and the long options of the same names (such as `--user`) in the form `--name=value` (value inside the option word) or `--name value` (separate word); for `exec` the option `-a`; for `xargs` the options `-I`, `-L`, `-n`, `-P`, `-s`, `-d`, `-E` and `-a`; for `time` the options `-f` and `-o`; for `nohup`, `command` and `builtin` no option takes a value.
6. WHEN the command is `sudo -u root env`, `exec -a x env`, `xargs -I {} printenv`, `time -o out.txt printenv` or `sudo --user=root printenv`, THE Deny_List SHALL reject it with the reason `protected-path`.
7. IF a shell command contains a path with a Proc_Glob followed by a later segment that matches `environ`, THEN THE Deny_List SHALL reject the command with the reason `protected-path`, including `/pr?c/self/environ`, `/p*/self/environ` and `/[p]roc/1/environ`.
8. WHEN `isEnvironPath` receives `/pr?c/self/environ`, `/p*/self/environ`, `/[p]roc/1/environ` or any tool path of that shape, THE `isEnvironPath` function SHALL return true, so that `decide` rejects it as an Environ_Path under Requirement 8, criterion 3.
9. THE test file `apps/runner/test/key-reader.test.ts` SHALL list every denied example of criteria 1 to 8 (`eval env`, `eval "printenv HOME"`, `eval 'sh -c env'`, `echo env | sh`, `printf 'env' | bash`, `bash <<< env`, `cat x | bash -s`, `sudo -u root env`, `exec -a x env`, `xargs -I {} printenv`, `time -o out.txt printenv`, `sudo --user=root printenv`, `/pr?c/self/environ`, `/p*/self/environ`, `/[p]roc/1/environ`) in its DENIED examples and SHALL assert that `matchDenyList` rejects each with the reason `protected-path`. THE same file SHALL list `sh script.sh`, `bash -c "git status"` and `git log | sort` in its allowed examples, SHALL assert that `isEnvironPath` returns true for the three Proc_Glob paths, and SHALL assert that an `eval` chain nested deeper than 4 levels is rejected.
10. THE file `docs/SANDBOX.md` SHALL state in one line that the deny list is best-effort and that the dedicated key bounded by Séance's credit caps (Requirement 11) is the real control.
11. WHEN `pnpm typecheck` and `pnpm test` run at the repository root with the Requirement 14 changes applied, THE `apps/runner` and `apps/ircd` projects SHALL pass both with exit code 0, and THE Requirement 14 changes SHALL NOT modify `apps/web/next-env.d.ts`.

### Requirement 15: API-key-only deploy hosts

**User Story:** As an operator of the public host, I want `deploy/bootstrap.sh`, `deploy/update.sh` and the systemd units to work with only `KIRO_API_KEY` set, so that the ircd starts without a Kiro login and no login-refresh job runs against a login that does not exist.

The terms below extend the Glossary for this requirement.

- **Env_File**: `/etc/seance/seance.env`, the host environment file read by the ircd service.
- **Host_Key**: The value of `KIRO_API_KEY` set in the Env_File. A line with an empty or whitespace-only value counts as unset (Requirement 9).
- **Host_Auth_Dir**: The value of `SEANCE_SANDBOX_AUTH_DIR` set in the Env_File. An empty or whitespace-only value counts as unset (Requirement 3). A commented-out line counts as unset.
- **Bootstrap_Script**: `deploy/bootstrap.sh`, including its `ready_for_agents` gate.
- **Update_Script**: `deploy/update.sh`.
- **Refresh_Script**: `deploy/seance-kiro-refresh.sh`, installed as `/usr/local/sbin/seance-kiro-refresh`.
- **Refresh_Timer**: The unit `seance-kiro-refresh.timer`.
- **Ircd_Unit**: `deploy/systemd/seance-ircd.service`.
- **Deploy_Docs**: `docs/DEPLOY.md` (section 5, "Kiro login") and `deploy/seance.env.example`.
- **Deploy_Tests**: The tests in `apps/runner/test/sandbox-files.test.ts` that read files under `deploy/` and `docs/`.

#### Acceptance Criteria

1. WHEN the Bootstrap_Script checks the Kiro credential and the Host_Key is set, THE Bootstrap_Script SHALL run `kiro-cli whoami` as the `seance` user with `KIRO_API_KEY` set to the Host_Key in the environment of that `kiro-cli` process.
2. WHILE the Bootstrap_Script runs the credential check of criterion 1, THE Bootstrap_Script SHALL keep the Host_Key out of the argv of every process it starts, including `sudo`, `su`, `env`, `runuser` and `kiro-cli`.
3. WHILE the Bootstrap_Script runs the credential check of criterion 1, THE Bootstrap_Script SHALL keep the Host_Key out of its stdout, its stderr, `/var/log/seance-bootstrap.log` and any `set -x` trace, including a run with `set -x` or `bash -x` enabled.
4. WHEN the Bootstrap_Script reads the Host_Key from the Env_File, THE Bootstrap_Script SHALL read it without sourcing the Env_File in the root shell and without echoing the line.
5. IF the Env_File sets `KIRO_API_KEY` to an empty or whitespace-only value, THEN THE Bootstrap_Script SHALL treat the Host_Key as unset and run the credential check of criterion 1 without `KIRO_API_KEY`.
6. WHEN the Host_Key is set and `kiro-cli whoami` as `seance` exits 0 with `KIRO_API_KEY` in its environment, THE Bootstrap_Script SHALL treat the Kiro credential as working. This holds when the `seance` user has no login and the Host_Auth_Dir is unset (verified with kiro-cli: `KIRO_API_KEY=<key> kiro-cli whoami` prints "Authenticated with API key" and exits 0).
7. IF the Host_Key is unset and `kiro-cli whoami` as `seance` fails, THEN THE Bootstrap_Script SHALL treat the Kiro credential as missing, SHALL keep the ircd from starting as it does today, and SHALL print a next step that names both options: the `kiro-cli login --use-device-flow` login and setting `KIRO_API_KEY` in the Env_File.
8. IF the Host_Key is set and `kiro-cli whoami` as `seance` fails, THEN THE Bootstrap_Script SHALL treat the Kiro credential as missing, SHALL keep the ircd from starting, and SHALL print a next step that names `KIRO_API_KEY` and `/etc/seance/seance.env` without printing the Host_Key.
9. WHEN the Bootstrap_Script finishes the credential check, IF the Host_Auth_Dir is set, THEN THE Bootstrap_Script SHALL run `systemctl enable --now seance-kiro-refresh.timer`; IF it is unset, criterion 10 applies.
10. WHEN the Bootstrap_Script finishes the credential check, IF the Host_Auth_Dir is unset, THEN THE Bootstrap_Script SHALL run `systemctl disable --now seance-kiro-refresh.timer` and SHALL NOT fail if the timer is not installed or not enabled.
11. WHEN the Update_Script restarts the agents, THE Update_Script SHALL enable the Refresh_Timer only if the Host_Auth_Dir is set, and SHALL otherwise run `systemctl disable --now seance-kiro-refresh.timer`.
12. WHEN the Bootstrap_Script or the Update_Script decides on the Refresh_Timer, THE script SHALL read the Host_Auth_Dir with the same rule: the last uncommented `SEANCE_SANDBOX_AUTH_DIR=` line of the Env_File, with a blank value counted as unset.
13. WHEN the Refresh_Script starts and `SEANCE_SANDBOX_AUTH_DIR` is unset or blank in its environment, THE Refresh_Script SHALL print exactly one log line starting with `seance-kiro-refresh:`, SHALL exit with status 0, and SHALL NOT read, copy, write or lock any file of the Kiro login.
14. IF `SEANCE_SANDBOX_AUTH_DIR` is absent from the Refresh_Script's process environment, THEN THE Refresh_Script SHALL read it from the Env_File with the rule of criterion 12 before applying criterion 13.
15. THE `seance-kiro-refresh.service` unit SHALL NOT contain `KIRO_API_KEY` in any `Environment=` line.
16. THE Ircd_Unit SHALL NOT contain a `ConditionDirectoryNotEmpty=` directive.
17. WHERE the Host_Auth_Dir is set, THE Ircd_Unit SHALL run an `ExecStartPre=` command that exits non-zero, so the ircd does not start, when the directory named by the Host_Auth_Dir has no entries. Because systemd cannot branch on the Env_File, the command reads `SEANCE_SANDBOX_AUTH_DIR` from the unit's `EnvironmentFile` and exits 0 when it is unset.
18. THE Ircd_Unit SHALL contain a comment stating that `bootstrap.sh` and the Runner at start (Requirement 4, criterion 1) check the credential.
19. THE Deploy_Docs SHALL describe the API-key path in `docs/DEPLOY.md` section 5: set `KIRO_API_KEY` in `/etc/seance/seance.env`, leave `SEANCE_SANDBOX_AUTH_DIR` unset, run no `kiro-cli login`, and expect no `seance-kiro-refresh.timer`.
20. THE `docs/DEPLOY.md` section 5 SHALL state that `bootstrap.sh` checks the key with `kiro-cli whoami` as `seance` and that the key does not appear in the argv of that check.
21. THE `docs/DEPLOY.md` section 5 SHALL tell the operator that switching a host from a login to the key means unsetting `SEANCE_SANDBOX_AUTH_DIR` and running `sudo /opt/seance/deploy/bootstrap.sh` again, which disables the Refresh_Timer, and that teardown (section 9) still disables the timer first.
22. THE `deploy/seance.env.example` SHALL show `SEANCE_SANDBOX_AUTH_DIR` as optional with the comment that it enables the login refresh timer, and SHALL keep `KIRO_API_KEY` as a placeholder (Requirement 6, criterion 6).
23. THE Deploy_Tests SHALL assert on the text of `deploy/bootstrap.sh` that the credential check passes the Host_Key through the environment of the `kiro-cli` process and that no line of the script places `KIRO_API_KEY=` followed by a variable expansion inside a command that is an argument of `sudo`, `su`, `runuser` or `env` on the same command line, and that the script contains no `set -x`, `bash -x` or `xtrace` option.
24. THE Deploy_Tests SHALL run the credential-check function of the Bootstrap_Script (or its extracted helper) in a shell with fake `kiro-cli`, `sudo` and `systemctl` commands on `PATH`, and SHALL assert that the Host_Key is absent from the recorded argv of every fake command, from captured stdout and stderr, and present in the environment seen by the fake `kiro-cli`.
25. THE Deploy_Tests SHALL assert that the Bootstrap_Script and the Update_Script enable the Refresh_Timer only inside a branch guarded by the Host_Auth_Dir check, and contain `systemctl disable --now seance-kiro-refresh.timer` for the unset case. The existing assertions on the number and position of the `systemctl enable ... seance-kiro-refresh.timer` lines SHALL be updated to the new structure.
26. THE Deploy_Tests SHALL run the Refresh_Script with `SEANCE_SANDBOX_AUTH_DIR` unset and with a blank value, and SHALL assert exit status 0, exactly one output line starting with `seance-kiro-refresh:`, and that no file under a temporary `HOME` was created or changed.
27. THE Deploy_Tests SHALL assert that the Ircd_Unit has no `ConditionDirectoryNotEmpty=` directive and that `docs/DEPLOY.md` section 5 and `deploy/seance.env.example` contain the statements of criteria 19, 20 and 22.
28. IF `shellcheck` is installed, THEN every changed file under `deploy/*.sh` SHALL pass `shellcheck --severity=style deploy/*.sh` (the command of the CI workflow) with exit code 0.
29. IF `shellcheck` is not installed, THEN the implementer SHALL report that it was not run, and the CI step `shellcheck --severity=style deploy/*.sh` SHALL remain the check.
30. WHEN `pnpm typecheck` and `pnpm test` run at the repository root with the Requirement 15 changes applied, THE `apps/runner` and `apps/ircd` projects SHALL pass both with exit code 0, and THE Requirement 15 changes SHALL NOT modify `apps/web/next-env.d.ts`.
