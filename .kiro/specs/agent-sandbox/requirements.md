# Requirements Document

## Introduction

`agent-sandbox` runs every `kiro-cli` agent process inside a rootless Podman container before Séance is exposed to the public (`DESIGN.md` §8, risk "Security"; `.kiro/steering/security.md`: "Agents run in a Podman container in production"). Today the runner spawns `kiro-cli acp` directly on the host (`apps/runner/src/harness/spawn.ts`), so a prompt-injected agent with `+o` has the full reach of the runner's Unix user. The sandbox removes that reach: the agent sees one channel worktree, a read-only copy of its profile directory, a read-only copy of the Kiro credentials, and a network that cannot touch the host's loopback or the cloud metadata endpoint.

`SEANCE_SANDBOX=none|podman` selects the mode. `none` (default) keeps today's behaviour for local development. `podman` is required whenever `IRCD_PUBLIC=1`. ACP stays newline-delimited JSON-RPC over stdio, carried by `podman run -i`.

The sandbox limits what an agent can **write and reach**. The Kiro credential reaches the container only as a read-only mount, never as an environment variable, but the agent process can still read it (it needs it), so a prompt-injected agent could send it to an allowed host. Egress is limited by a host rule to HTTPS towards the Kiro endpoints and package registries. `docs/SANDBOX.md` states these limits.

### Decisions on the Open Points (user, 2026-11-08)

1. **Commits:** no git inside the container. The runner commits on the host after an agent turn, with the hardened git of Requirement 9 (Requirement 14). A runner-side commit command (Open Point 1, option C) is a later spec.
2. **Kiro credentials:** mounted read-only, never placed in the environment of the container or of the `podman` process. The residual exfiltration risk is documented.
3. **Egress:** the host rule blocks `169.254.169.254` and the VPC CIDR and allows only HTTPS to the Kiro endpoints and package registries (Requirement 7).
4. **Spike S12** (Podman 5 on Linux) stays a task marked "run on EC2" and blocks no other task.
5. **Image:** pinned by digest and built from a Dockerfile in the repository.
6. **SELinux:** enforcing hosts are supported through bind-mount relabelling (`:Z` / `:z`, Requirement 5.7).

### Findings that shape the requirements

1. **The process model changes in podman mode.** Today one `kiro-cli` process serves all channels of an agent (`AcpHarness.procs` is keyed by nick). A container can mount only the paths it was started with, so one container cannot serve two worktrees. In podman mode there is one container, and one `kiro-cli` process, per (agent, session cwd).
2. **The agent profile directory must be mounted.** Kiro resolves `--agent <name>` from the process cwd (spike S8), which is `SEANCE_AGENTS_DIR`. The container therefore needs that directory, read-only, in addition to the worktree. This is the one mount beyond the brief and is deliberate.
3. **Git metadata is not mounted.** A worktree's `.git` is a file that points into `<repo>/.git/worktrees/<name>`. Mounting that path, `objects/` or `refs/` would give the agent write access to repository state shared with other channels, and to files (`config.worktree`) that the host runner's own `git` calls read. Inside the sandbox `git` therefore reports "not a repository", and an agent cannot commit. The runner commits for it on the host after each turn (decision 1, Requirement 14).
4. **The `.git` file inside a mounted worktree is agent-writable.** The runner runs `git -C <worktree> ...` on the host (`reset`, `status`, `diff`, `clean`). An agent that rewrites `.git` to point at a directory it controls would make the host run git with attacker-chosen config (for example `core.fsmonitor`) as the runner's user. Requirement 9 closes this.
5. **Podman copies host proxy variables into containers by default** (`--http-proxy`, default true). That would break "no host env except the allow-list" and is switched off explicitly.
6. **Rootless Podman cannot filter egress by destination.** Blocking `169.254.169.254`, the VPC and every non-HTTPS or non-allow-listed destination needs a rule on the host (nftables, matched by Unix user, because pasta opens the outbound sockets as that user). The runner verifies the result with a probe instead of trusting it (Requirement 7).
7. **nftables filters addresses, not names.** The allow-list of host names (Kiro endpoints, package registries) is resolved into an address set by an operator script on a timer. Addresses behind a shared CDN may also serve other sites; this is a documented limit.
8. **SELinux private labels lock out other containers.** A path relabelled `:Z` can be used by one container only. A channel worktree is mounted by every agent of the channel, and the agents and auth directories by every container, so those take the shared label `:z`; only the private session directory, which one container mounts, takes `:Z`.

## Glossary

- **Sandbox_Mode:** the value of `SEANCE_SANDBOX`: `none` or `podman`.
- **Sandbox_Image:** the container image named by `SEANCE_SANDBOX_IMAGE`. Its contract is in `docs/SANDBOX.md`: non-root user, entrypoint that accepts `acp --agent <name>`, `seance-probe`.
- **Session_Cwd:** the directory passed to ACP `session/new`: a channel worktree, or `<workspaces>/_private/<nick>` for a private session.
- **Container_Name:** `seance-<nick>-<8 hex of sha256(channel or private cwd)>-<8 random hex>`, with nick restricted to `[a-z0-9-]`.
- **Sandbox_Labels:** `io.seance.sandbox=1`, `io.seance.workspaces=<16 hex of sha256(Worktree_Root)>`, `io.seance.agent=<nick>`.
- **Launcher:** the component that builds the `podman run` command and removes containers (`apps/runner/src/sandbox`).
- **Preflight:** the checks and the network probe the Runner performs in `start()` when Sandbox_Mode is `podman`.
- **Probe:** `seance-probe`, a script in the Sandbox_Image that exits `0` only when the host loopback and the metadata endpoint are unreachable.
- **Auth_Dir:** the host directory named by `SEANCE_SANDBOX_AUTH_DIR` holding the Kiro login state.
- **Runner / Ircd / Worktree_Manager / Human_Op:** as in `agent-runner`.

## Non-goals

- Running the Runner itself inside a container (nested Podman) or talking to a remote Podman socket.
- Docker, rootful Podman, `--privileged`, gVisor or Kata. Only rootless Podman 5 or newer on Linux.
- macOS and Windows hosts in podman mode. Developers use `SEANCE_SANDBOX=none`.
- Hiding the Kiro credential from the agent process.
- Committing from inside the sandbox, and a commit command for Human_Ops (Open Point 1, option C: a later spec).
- Host-side commits in `none` mode (agents commit themselves there, as today).
- Name-based egress filtering inside the runner (the host rule filters addresses).
- The headless harness (`SEANCE_HARNESS=headless`) in podman mode.

---

## Requirements

### Requirement 1: Configuration

**User Story:** As an operator, I want a small set of validated variables, so that the sandbox cannot be half configured.

#### Acceptance Criteria

1. THE Runner SHALL read `SEANCE_SANDBOX` with the values `none` and `podman`. Unset or empty SHALL mean `none`. Any other value SHALL be a `ConfigError` naming the variable and the rejected value.
2. WHEN Sandbox_Mode is `podman`, THE Runner SHALL also read: `SEANCE_PODMAN_BIN` (default `podman`), `SEANCE_SANDBOX_IMAGE` (required), `SEANCE_SANDBOX_AUTH_DIR` (required), `SEANCE_SANDBOX_MEMORY` (default `2g`), `SEANCE_SANDBOX_CPUS` (default `2`), `SEANCE_SANDBOX_PIDS` (default `256`), `SEANCE_SANDBOX_TIMEOUT_S` (default `86400`), `SEANCE_SANDBOX_KIRO_BIN` (default `kiro-cli`, the command name inside the image), `SEANCE_SANDBOX_EGRESS_PROBES` (default `1.1.1.1:443`, Requirement 7.7), `SEANCE_SANDBOX_BLOCKED_CIDRS` (default none, Requirement 7.7).
3. THE Runner SHALL accept `SEANCE_SANDBOX_MEMORY` only as `^[1-9][0-9]*[kmg]$` (case-insensitive), `SEANCE_SANDBOX_CPUS` only as a decimal greater than 0 and at most 64, `SEANCE_SANDBOX_PIDS` only as an integer from 16 to 4096, `SEANCE_SANDBOX_TIMEOUT_S` only as an integer from 60 to 604800, `SEANCE_SANDBOX_EGRESS_PROBES` only as a comma-separated list of one to eight `<dotted IPv4>:<port 1-65535>` entries, and `SEANCE_SANDBOX_BLOCKED_CIDRS` only as one to eight IPv4 CIDRs (`a.b.c.d/0..32`). Any other value SHALL be a `ConfigError` naming the variable.
4. WHEN Sandbox_Mode is `podman`, THE Runner SHALL require `SEANCE_SANDBOX_AUTH_DIR` (decision 2: the credential reaches the container only as a read-only mount). A missing value SHALL be a `ConfigError` naming the variable; a path that is not an existing directory SHALL fail `validateRunnerPaths` naming the variable. `KIRO_API_KEY` SHALL NOT count as a credential source in podman mode; when it is set, the Runner SHALL log once that it is not forwarded to the sandbox. **Superseded by `sandbox-api-key-auth` Requirements 1 and 4:** in podman mode `KIRO_API_KEY` is a credential source, forwarded name-only; one of it or `SEANCE_SANDBOX_AUTH_DIR` is required.
5. THE image name, paths and the podman binary SHALL be rejected when they contain a comma, a double quote, a NUL, CR or LF, or when the image name starts with `-`.
6. WHEN Sandbox_Mode is `podman` and `SEANCE_HARNESS=headless`, THE Runner SHALL fail with a `ConfigError` stating that the headless harness cannot be sandboxed.
7. THE Runner SHALL ignore `SEANCE_KIRO_BIN` in podman mode (the command inside the image is `SEANCE_SANDBOX_KIRO_BIN`) and SHALL log that once at startup.
8. `SEANCE_SANDBOX_IMAGE` SHALL be pinned by digest (decision 5): it SHALL match `^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$`. A tag-only or ID-only reference SHALL be a `ConfigError` naming the variable and saying how to read the digest.

### Requirement 2: Production guard

**User Story:** As an operator, I want a public server to refuse to run agents unsandboxed.

#### Acceptance Criteria

1. `apps/ircd` SHALL read `IRCD_PUBLIC`. The value `1` SHALL mean a publicly exposed deployment; unset, empty or `0` SHALL mean not public; any other value SHALL stop startup with a message naming the variable.
2. WHEN `IRCD_PUBLIC=1`, `SEANCE_RUNNER=1` and Sandbox_Mode is not `podman`, THE Ircd SHALL refuse to start: exit code non-zero, message naming `IRCD_PUBLIC` and `SEANCE_SANDBOX`, no listener opened, no process spawned.
3. WHEN `IRCD_PUBLIC=1` and `SEANCE_RUNNER` is not `1`, no agent can run and the guard SHALL NOT trigger.
4. THE guard SHALL be a pure function `assertSandboxForPublic({ public, runnerEnabled, sandbox })` with unit tests for every combination.
5. `createRunner` SHALL receive `publicDeployment` and SHALL repeat the check in `start()`, so embedding the runner elsewhere cannot skip it.

### Requirement 3: Preflight and fail closed

**User Story:** As an operator, I want the runner to stop at boot, not at the first invite, when the sandbox cannot work.

#### Acceptance Criteria

1. WHEN Sandbox_Mode is `podman`, `start()` SHALL run the Preflight before it accepts any invite. A failed Preflight SHALL reject `start()` with a `SandboxError` and the Ircd SHALL exit non-zero, as for other startup failures.
2. THE Preflight SHALL check, in order: (a) `podman --version` runs and reports major version 5 or higher; (b) `podman info --format json` reports `host.security.rootless == true`; (c) the Sandbox_Image exists locally under its digest reference (`podman image exists <name>@sha256:<digest>`); no pull is ever performed; (d) the Auth_Dir exists and is a directory; (e) the Probe runs in a container with the production network flags and exits `0`.
3. THE Probe SHALL fail the Preflight when it can reach a listener the Runner opened on the host's `127.0.0.1` (ephemeral port, closed afterwards) through the container's default gateway, when it can open a TCP connection to `169.254.169.254:80`, or, in a public deployment, when it can open a TCP connection to any target of `SEANCE_SANDBOX_EGRESS_PROBES` (Requirement 7.7).
4. EACH failure SHALL produce a `SandboxError` with a `kind` (`podman-missing`, `podman-version`, `not-rootless`, `image-missing`, `auth-missing`, `probe-failed`) and a message that states what failed and what to change. A `probe-failed` message SHALL name the check (host loopback, metadata endpoint, or egress allow-list). Messages SHALL contain no secret value.
5. THE Runner SHALL re-run the cheap checks (3.2 a to c) before every container start, so that a podman binary or image removed after boot fails the start instead of falling back to a host process.
6. THE Runner SHALL NOT fall back to a host process when any sandbox step fails.

### Requirement 4: Container isolation flags

**User Story:** As a security reviewer, I want the container flags fixed in one place and tested.

#### Acceptance Criteria

1. THE Launcher SHALL build every agent container with exactly this set, each flag once: `run`, `-i`, `--rm`, `--name=<Container_Name>`, the three Sandbox_Labels, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--pids-limit=<N>`, `--memory=<M>`, `--memory-swap=<M>`, `--cpus=<C>`, `--user=10001:10001`, `--userns=keep-id:uid=10001,gid=10001`, `--pull=never`, `--http-proxy=false`, `--no-hosts`, `--log-driver=none`, `--timeout=<T>`, `--stop-timeout=2`, `--hostname=seance-agent`, `--workdir=<SEANCE_AGENTS_DIR>`, `--network=pasta:--no-map-gw,--ipv4-only`, and `--tmpfs` entries for `/tmp` and `/home/agent`.
2. THE Launcher SHALL NEVER emit `--privileged`, `--cap-add`, `--device`, `-v`, `--volume`, `--pid`, `--ipc`, `--uts`, `--userns=host`, `--network=host`, `--security-opt` other than `no-new-privileges`, `--env-file`, `--env-host`, `--add-host`, `--group-add`, `--publish`, `-p`, `-P` or `--expose`.
3. THE `/tmp` and `/home/agent` tmpfs entries SHALL carry `rw,nosuid,nodev,noexec,size=<bounded>` (review item 1). `kiro-cli`, the entrypoint and the probe SHALL live in `/usr/local/bin` of the image, and `SEANCE_SANDBOX_KIRO_BIN` SHALL be a bare name or an absolute image path outside `/home/agent`, `/tmp` and `/run`; the Launcher passes it as `-e SEANCE_KIRO_BIN=<value>`.
4. THE image SHALL be the first argument after the last flag, followed by exactly `acp`, `--agent`, `<kiroAgent>`. Nothing else follows.
5. IN podman mode THE Registry SHALL accept a `kiroAgent` only when it matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, so it cannot be read as a flag.
6. THE container user SHALL be unprivileged (uid 10001) and files the agent writes in the worktree SHALL be owned by the runner's Unix user on the host (`keep-id`).

### Requirement 5: Mounts

**User Story:** As a security reviewer, I want to see every path the agent can touch.

#### Acceptance Criteria

1. THE Launcher SHALL emit exactly these `--mount type=bind` entries and no others: (a) `src=<Session_Cwd>,dst=<Session_Cwd>,rw` (same path inside and outside, so ACP `cwd` and `rawInput.path` values mean the same thing to the Runner and to the agent); (b) `src=<SEANCE_AGENTS_DIR>,dst=<SEANCE_AGENTS_DIR>,ro`; (c) `src=<Auth_Dir>,dst=/run/seance/auth,ro`.
2. EVERY bind mount SHALL carry `bind-propagation=rprivate` and `nosuid,nodev`; the read-only ones SHALL also carry `ro`.
3. THE Session_Cwd and the Auth_Dir SHALL be resolved with `realpath` before use. THE Launcher SHALL refuse a Session_Cwd that is not inside the Worktree_Root, is the Worktree_Root itself, or contains the Auth_Dir, the agents directory, the target repository, or `/`.
4. THE Launcher SHALL refuse a Session_Cwd that overlaps the Auth_Dir or the agents directory in either direction.
5. NOTHING else from the host SHALL be visible: no socket, no `/proc/sys` write, no home directory, no `.git` metadata, no repository path other than through the worktree files.
6. THE Auth_Dir SHALL be staged by the image entrypoint: copied from `/run/seance/auth` into the container's tmpfs `$HOME` before `kiro-cli` starts, so that read-only storage and token refresh both work and nothing is written back to the host.
7. EVERY bind mount SHALL carry an SELinux relabel option (decision 6, finding 8): `relabel=private` (`:Z`) for a private session directory, which exactly one container mounts; `relabel=shared` (`:z`) for a channel worktree, the agents directory and the Auth_Dir, which several containers mount at the same time. On a host without SELinux, Podman ignores the option. The Launcher SHALL NOT emit `--security-opt label=disable`.

### Requirement 6: Environment

**User Story:** As an operator, I want no host variable to reach the agent by accident.

#### Acceptance Criteria

1. THE container environment SHALL contain only: `HOME=/home/agent`, `TMPDIR=/tmp`, `LANG`, `LC_*` and `TERM` (names from the existing allow-list, `child-env.ts`) forwarded by name, and explicit test variables passed through `extraEnv`.
2. THE Launcher SHALL pass forwarded variables as `-e NAME` without a value, so no value appears in the argument list or in `ps`. The `podman` process itself SHALL get the allow-listed environment plus `XDG_RUNTIME_DIR`, plus the forwarded variables it needs to resolve those names.
3. `PATH`, `HOME` and `TMPDIR` of the host SHALL NOT be forwarded.
4. `KIRO_API_KEY` SHALL NOT be forwarded to the container, nor placed in the environment of the `podman` process, even when the Runner's own environment holds it (decision 2). It SHALL never appear in `argv`, in logs, in error messages or in notices; the existing `redact` stays on every path. **Superseded by `sandbox-api-key-auth` Requirements 1 and 4:** in podman mode `KIRO_API_KEY` is a credential source, forwarded name-only; one of it or `SEANCE_SANDBOX_AUTH_DIR` is required.
5. `--http-proxy=false` SHALL always be present (finding 5).

### Requirement 7: Network

**User Story:** As a security reviewer, I want egress limited to HTTPS towards Kiro and package registries, and nothing towards the host, the metadata endpoint or the VPC.

#### Acceptance Criteria

1. THE container SHALL use rootless `pasta` networking with the gateway-to-host mapping off (`--no-map-gw`) and IPv4 only.
2. THE Runner SHALL NOT depend on any host firewall for host-loopback isolation; the Probe SHALL verify it (3.3).
3. FOR the metadata endpoint, the VPC and the egress allow-list the Runner SHALL depend on a host rule matched by the Unix user running the Runner (decision 3). THE repository SHALL ship it as `sandbox/seance-sandbox.nft`, with placeholders for the user, the VPC CIDR and the DNS resolver. For that user the rule SHALL, in this order: accept established and related traffic; accept DNS (UDP and TCP 53) to the resolver only; drop `169.254.0.0/16` (which covers `169.254.169.254`); drop the VPC CIDR; accept loopback destinations (`127.0.0.0/8`, the Runner's own services; the container cannot reach them because of 7.1); accept TCP 443 to the addresses of the allow-list set; drop everything else, IPv4 and IPv6.
4. A host that cannot be shown to block a target (no cloud, no listener) SHALL pass the Probe; `docs/SANDBOX.md` SHALL say that a pass means "not reachable now", not "blocked by rule".
5. THE container SHALL have no published ports.
6. THE allow-list SHALL ship as host names in `sandbox/egress-allow.txt` (the Kiro endpoints, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`), one per line with `#` comments, and SHALL be loaded into the nftables set by `sandbox/seance-egress-refresh` (POSIX sh), which resolves every name and replaces the set atomically. The script is run by the operator on a timer, never by the Runner.
7. IN every podman start (review finding 4; not only with `IRCD_PUBLIC=1`) THE Probe SHALL also try every target of `SEANCE_SANDBOX_EGRESS_PROBES` (default `1.1.1.1:443`, an address outside the allow-list) and the first address after the network address, port 443, of every CIDR of `SEANCE_SANDBOX_BLOCKED_CIDRS` (optional; the VPC and other ranges the host rule drops), and SHALL fail with exit code `13` when any of them connects, so a host without the default-deny rule fails the Preflight.
8. `docs/SANDBOX.md` SHALL state the residual risks: the agent can send the staged credential to any allowed host (decision 2); allow-listed addresses behind a shared CDN may serve other sites (finding 7); services the Runner's user reaches outside loopback must be added to the rule by hand and are then reachable for agents too.

### Requirement 8: One container per session

**User Story:** As an operator, I want a kicked agent in one channel to leave other channels untouched.

#### Acceptance Criteria

1. IN podman mode THE `AcpHarness` SHALL key its processes by (agent nick, Session_Cwd) and SHALL run one `podman run -i` process, and one ACP session, per key. In `none` mode the key stays the nick.
2. `terminate(profile)` SHALL stop every container of that agent. `hasProcess(profile)` SHALL be true while any container of that agent runs.
3. THE `hung`, `exited` and process-event semantics SHALL be unchanged for consumers: the events carry the agent nick and the session ids of that container.
4. THE time to open a session SHALL stay within `SESSION_OPEN_TIMEOUT_MS` (30 s) on a host with the image present; a container that needs longer SHALL fail with the "start failed" notice, not hang the invite.
5. PRIVATE sessions SHALL run in their own container with `<Worktree_Root>/_private/<nick>` as Session_Cwd.
6. Credits, the hung watchdog and the permission handler SHALL work per container without change to their interfaces.

### Requirement 9: Host-side git hardening

**User Story:** As a security reviewer, I want a rewritten `.git` file to be harmless.

#### Acceptance Criteria

1. THE Worktree_Manager SHALL record, for each worktree, the absolute git dir (`<repo>/.git/worktrees/<name>`) when it creates or first reuses the worktree, read from the main repository side (`git -C <repo> worktree list --porcelain`), never from files inside the worktree.
2. IN podman mode EVERY host-side git call on a worktree (`reset`, `clean`, `status`, `diff`, `rev-parse`, `config`, `sparse-checkout`) SHALL pass `--git-dir=<recorded dir>` and `--work-tree=<worktree>` and SHALL run with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointing at `/dev/null` and `GIT_TERMINAL_PROMPT=0`.
3. BEFORE each prompt THE guard SHALL compare the worktree's `.git` file with the expected `gitdir: <recorded dir>` line; any difference SHALL be reported to the Human_Ops, the file SHALL be restored, and the worktree SHALL be reset.
4. THE `.git` file SHALL be restored with a write that refuses to follow a symlink.
5. A test SHALL rewrite `.git` inside a worktree to point at a directory whose config sets `core.fsmonitor` to a script that creates a marker file, run the guard, and assert that the marker file does not exist.

### Requirement 10: Lifecycle and cleanup

**User Story:** As an operator, I want no container to outlive the session that owns it.

#### Acceptance Criteria

1. WHEN a Session reaches `closed` through exorcism (`kick`, `part`, `quit`), THE Runner SHALL stop and remove its container: `podman stop -t 2 <name>` then `podman rm -f --ignore <name>`, both awaited, before the exorcism is reported finished.
2. WHEN the agent process exits, hangs and is killed, is banned, or the Runner shuts down, THE Runner SHALL remove the container the same way.
3. WHEN removal fails, THE Runner SHALL log the cause, notify the Human_Ops of the channel once, and retry at the next sweep. It SHALL NOT report the exorcism as clean.
4. AT startup and at shutdown THE Runner SHALL remove every container that carries `io.seance.sandbox=1` and the `io.seance.workspaces` label of its own Worktree_Root (`podman ps -a -q --filter label=...`, then `podman rm -f`). Containers of another Worktree_Root SHALL be left alone.
5. THE `--timeout=<SEANCE_SANDBOX_TIMEOUT_S>` flag SHALL bound the lifetime of a container, so a container orphaned by a killed Runner ends by itself. A container that ends this way SHALL be treated as an exited process (session revival applies).
6. KILLING the `podman run` client SHALL NOT be the only stop path; the name-based `stop`/`rm` of 10.1 is authoritative.
7. THE Runner SHALL track container names in memory and SHALL NOT remove a container whose name it did not create in this run, except in the sweep of 10.4.

### Requirement 11: Failure notices

**User Story:** As a channel operator, I want to know why an invited agent did not appear.

#### Acceptance Criteria

1. WHEN podman is missing, the image is missing, the container fails to start, or the Probe or a pre-start check fails, THE agent SHALL NOT start, no host process SHALL be spawned, and the Human_Ops of the channel SHALL receive one NOTICE: `sandbox: <agent> not started in <channel>: <reason>`.
2. `<reason>` SHALL come from a fixed set (`podman not found`, `podman too old (need 5 or newer)`, `podman is not rootless`, `sandbox image not found`, `container failed to start`, `container start timed out`, `network isolation check failed`) plus, for `container failed to start`, the last stderr line of `podman` after control stripping and `redact`, cut to 200 bytes.
3. A `podman run` exit code of 125, 126 or 127 before `initialize` completes SHALL count as "container failed to start".
4. THE notice SHALL contain no host path outside the worktree and no secret.
5. THE existing invite failure path SHALL clean up as for other pipeline failures (the agent parts the channel, the Invite_Key is released, no session is registered).
6. THE failure SHALL be logged with the agent, channel, kind and cause.

### Requirement 12: Tests

**User Story:** As a maintainer, I want the isolation pinned by tests that run without Podman, and by tests that run with it.

#### Acceptance Criteria

1. UNIT tests SHALL cover the argv builder, the config parsing, the production guard, the path checks and the notice texts.
2. PROPERTY tests (fast-check, at least 100 runs) SHALL cover P1 to P6 of `design.md`.
3. A fake `podman` executable (`apps/runner/test/fixtures/fake-podman`) SHALL implement `--version`, `info`, `image exists`, `run -i` (ignores flags, records them, runs the Fake_Agent), `ps`, `stop`, `rm` and exit-code failures, so lifecycle and failure behaviour are tested on hosts without Podman.
4. AN integration suite SHALL run the Fake_Agent inside a real rootless container (`apps/ircd/test/runner/sandbox.integration.test.ts`) and use `it.skipIf(!podmanAvailable)` so Vitest reports the tests as skipped, with the reason in the title, when Podman is absent. It SHALL NOT silently pass.
5. THE integration suite SHALL assert: the ACP handshake and a streamed reply through `podman run -i`; a file written in the worktree appears on the host owned by the runner's user; writes outside the worktree and to `/` fail; `CapEff` is zero and `NoNewPrivs` is 1; the user is not root; a host secret variable set in the Runner's environment, and `KIRO_API_KEY`, are absent; a listener on the host's `127.0.0.1` is unreachable; `169.254.169.254:80` is unreachable; `git rev-parse` fails inside; after an `end_turn` of a `+o` agent the host branch has a new commit authored by the agent; after a kick the container no longer appears in `podman ps -a`; with a bogus `SEANCE_PODMAN_BIN` or image the invite produces the notice and no container. **Superseded by `sandbox-api-key-auth` Requirements 1 and 4:** in podman mode `KIRO_API_KEY` is a credential source, forwarded name-only; one of it or `SEANCE_SANDBOX_AUTH_DIR` is required.
6. NO test SHALL pull an image or require network access beyond a loopback listener; the test image is built from a base image that is already present, or the suite skips with that reason.
7. UNIT tests SHALL cover the host-side commit of Requirement 14 against a real temporary git repository (no Podman needed): commit after `end_turn` with `+o`, no commit without `+o`, after `cancelled`, while closing, on a clean worktree, or with protected config present; hooks in the repository are not run; the next prompt waits for the commit; a cancel during the commit sends no `session/cancel`.
8. A repository test SHALL check that every `FROM` line of `sandbox/Dockerfile` and of the test image Dockerfile is pinned by `@sha256:<64 hex>`.

### Requirement 13: Documentation and naming

**User Story:** As an operator, I want one document that says how to run this safely.

#### Acceptance Criteria

1. `docs/SANDBOX.md` SHALL describe: the threat model and its limits, the variables, the container flags, the mounts and their SELinux labels, the network, the nftables rule and the allow-list refresh, the image contract and how to read its digest, the lifecycle, host-side commits, failure notices, the residual credential exfiltration risk, and how to verify a host.
2. `README.md` SHALL list the new variables in the runner table, and `DESIGN.md` §8 SHALL link to `docs/SANDBOX.md` and state the process-model change and Open Point 1.
3. THE trademarked client name forbidden by `product.md` SHALL NOT appear in any file this spec adds or changes.
4. All text, comments and commit messages SHALL be English.

### Requirement 14: Host-side commits after a turn

**User Story:** As a channel operator, I want an op agent's work committed on its channel branch, without giving the container any git metadata.

#### Acceptance Criteria

1. IN podman mode, WHEN a channel Session's turn ends with `end_turn`, the Session is not closing, and the agent holds `+o` in the channel at that moment, THE Runner SHALL commit the worktree's changes on the host before the turn is reported finished.
2. THE commit SHALL use the hardened git of Requirement 9.2 and additionally `-c core.hooksPath=/dev/null`, `-c commit.gpgSign=false`, `--no-verify`, committer `Séance runner <runner@seance.invalid>` and author `<agent> <<agent key>@seance.invalid>`, where the key is the `irc_lower` nick with every character outside `[a-z0-9._-]` replaced by `-`. The message SHALL be `<agent>: turn in <channel>` and SHALL contain no text written by the agent.
3. BEFORE committing THE Runner SHALL scan the worktree for protected config (`AGENTS.md`, `.kiro`, Requirement 9 of `agent-runner`); on a hit it SHALL NOT commit, and the next prompt guard resets the worktree as today.
4. A worktree with no change (empty `git status --porcelain`) SHALL produce no commit and no notice.
5. THE next prompt of that Session SHALL NOT be sent before the commit has finished, and a cancel that arrives while the commit runs SHALL send no `session/cancel` (the turn is already over).
6. ON success THE Runner SHALL send one ChanServ notice `<agent> committed <sha7> (<n> files)` to the channel. ON failure it SHALL log the cause, send the Human_Ops one notice `<agent>: commit failed in <channel> (see the runner log)`, and leave the worktree as it is.
7. NO commit SHALL be made after a turn that ended `cancelled`, `other` or with an error, or for a Private_Session, so a `/kick` still discards an unfinished turn.
8. IN `none` mode nothing changes: no host-side commit is made.

### Requirement 15: Review fixes (2026-11-08)

#### Acceptance Criteria

1. NESTED GIT (finding 1). THE worktree scan SHALL report any `.git` below the worktree root (directory, file or symlink, any letter case) and any `.gitmodules`, like `AGENTS.md` and `.kiro`, and SHALL NOT descend into a `.git` it found. THE host-side commit SHALL be refused while the scan reports anything. EVERY hardened host git call on a worktree SHALL pass `-c core.fsmonitor=false -c core.untrackedCache=false -c submodule.recurse=false` before `--git-dir`, and `git status` SHALL pass `--ignore-submodules=all` (`git add` has no such option).
2. OPEN SERIALISATION (finding 2, amended by item 3). IN podman mode, a second `openSession` for an (agent, cwd) whose open is in flight SHALL be rejected with `SandboxError("invalid-input")` saying a session for that agent and directory is already being opened; it SHALL NOT receive the first caller's session, and the first caller's session and container SHALL be unaffected. An open for a pair whose container is still registered, whatever sessions it holds, SHALL be refused with `SandboxError("invalid-input")` and start nothing.
3. SHUTDOWN (finding 3). ONCE `dispose()` has started, `openSession` SHALL reject. A container created by an open in flight SHALL be stopped and removed before `dispose()` resolves, and an open that completes after `dispose()` started SHALL NOT return a session.
4. EGRESS PROBE (finding 4). See 7.7.
5. IMAGE (finding 5). `sandbox/Dockerfile` SHALL fail the build unless `--build-arg KIRO_CLI_SHA256=<digest>` matches `/usr/local/bin/kiro-cli`, checked before `USER`. `/home/agent` is `noexec` (superseded by 4.3; spike S12 confirms `kiro-cli` starts with it, `S12_HOME_EXEC=1` is the comparison run). DNS tunnelling SHALL be listed there as a residual risk.
6. SWEEP (finding 6). THE sweep SHALL list container names (`ps -a --format {{.Names}}`), pass only Séance container names to `rm`, and forget the names it removed.
7. PUBLIC EGRESS (item 2). `assertSandboxForPublic` SHALL also throw `PublicEgressError`, naming `SEANCE_SANDBOX_BLOCKED_CIDRS` and `IRCD_PUBLIC`, when the deployment is public, the runner is enabled, the sandbox is podman and no CIDR is configured. `apps/ircd` and `runner.start()` SHALL both check it. `docs/SANDBOX.md` SHALL say the egress probe is best effort: an unreachable host looks the same as a blocked one.
8. REFUSED REPOSITORIES (item 4). `README.md` and `docs/SANDBOX.md` SHALL state that a target repository that commits `.gitmodules`, and any nested `.git` in a worktree, are refused by design (also in `none` mode), and a test SHALL show `ensure` refusing a repository with `.gitmodules`.

### Requirement 16: Node and npm in the agent image (task 21, demo blocker 2026-11-10)

**User Story:** As a channel operator, I want an op agent to run the project's tests in the sandbox, so that "fix, run the tests, then commit" works on the public host.

#### Acceptance Criteria

1. `sandbox/Dockerfile` SHALL provide Node 26 and npm by a multi-stage copy from `docker.io/library/node:26-bookworm-slim` pinned by the same digest as the test image (`apps/runner/test/fixtures/sandbox/Dockerfile`), copying only the `node` binary and the npm files (with `npx`); the image ships no corepack, because Node 25 and later images no longer include it (task 21.3); every `FROM`, including the build stage, SHALL stay pinned by digest (12.8).
2. THE image SHALL keep running as uid 10001, and the setuid and setgid bits SHALL be stripped after the last `COPY`, before `USER`.
3. THE build SHALL add no network install beyond the existing apt line (no `npm install`, `curl` or `wget`).
4. npm SHALL work offline for a project without dependencies: its cache and logs live in the tmpfs `$HOME` (`NPM_CONFIG_CACHE=/home/agent/.npm`), and `NPM_CONFIG_OFFLINE`, `NPM_CONFIG_UPDATE_NOTIFIER=false`, `NPM_CONFIG_FUND=false` and `NPM_CONFIG_AUDIT=false` keep it from asking the registry. The test image SHALL carry the same settings.
5. A real-Podman case (skipped without Podman and the pinned base) SHALL run `node --version` and `npm test` for a throwaway project inside the container.
6. `docs/SANDBOX.md` SHALL list the image contents and explain that the worktree has no git metadata on purpose (D3) and how the runner commits.
7. THE image SHALL install `libatomic1` (the copied `node` binary links `libatomic.so.1`) and SHALL run `node --version` at build time, so a missing shared library fails the build (task 21.4).
8. `deploy/bootstrap.sh` SHALL reuse the current agent image only when its label `io.seance.context-sha` equals the sha256 over every file of `sandbox/` (sorted) plus the kiro-cli binary's sha; otherwise it SHALL rebuild with `--pull=never`, log "agent image rebuilt: sandbox context changed", and restart `seance-ircd` when it is running (task 21.4).

### Requirement 17: One git rule in the agent instructions (task 21.2)

**User Story:** As a channel operator, I want the coder to treat the missing git metadata in the sandbox as normal, so that it neither reports a broken worktree nor asks me to install anything.

#### Acceptance Criteria

1. THE coder's agent config (`agents/.kiro/agents/coder.json`) and the `seance-fix-and-commit` skill SHALL state one rule for both sandbox modes: run tests with `npm test`; commit with git as usual; IF git says "not a git repository", that is expected in the Podman sandbox (no git metadata on purpose, D3) and the runner commits the worktree after the turn as `<agent>: turn in <channel>`; the agent SHALL NOT try to repair the worktree, SHALL NOT ask the user to install anything, and SHALL say in one line that the runner will commit.
2. THE runner's code SHALL NOT change for this: `none` mode keeps working as today (the agent commits, Requirement 14.8), and production runs podman (`guard.ts`).
3. `scripts/demo-journey.py` SHALL ask the coder to "run `npm test`, then commit (in the sandbox the runner commits for you)", and its commit check SHALL accept either the coder's own report or ChanServ's `coder committed <sha>`.
4. THE WHOIS `tools:` text SHALL stay unchanged: it comes from the agent profile and is shared by both modes, so `commits by runner` would be false with `SEANCE_SANDBOX=none`.
5. A repository test SHALL check that both instruction texts contain `npm test` and the "not a git repository … runner commits" rule.
