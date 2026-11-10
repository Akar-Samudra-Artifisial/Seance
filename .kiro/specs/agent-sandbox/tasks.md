# Implementation Plan: agent-sandbox

## Overview

Spike scripts and pinned flag spellings first, then pure code (config, guard, argument builder), then the launcher with a fake podman, the harness and runner wiring, host git hardening and host-side commits, the image files and the real-Podman integration suite, and the docs. Each property test carries its design ID (`P1` to `P6`) in its name. Verify per package (`pnpm --filter @seance/runner typecheck`, `pnpm --filter @seance/runner test`); root turbo runs may time out here. Rebuild the runner (`pnpm --filter @seance/runner build`) before ircd tests that import `@seance/runner`. `SEANCE_SANDBOX=none` must keep every existing test green without change. Never delete a test to make it pass. Fixing a bug starts with a failing test. No new npm dependency. Every task except 0.4 runs on macOS; 0.4 is marked "run on EC2" and no task depends on it (decision 4).

## Tasks

- [x] 0. Spike S12 scripts and pinned flag spellings
  - [x] 0.1 Write `spikes/acp/src/s12-podman.ts` and a `s12` script in `spikes/acp/package.json`
    - Using a throwaway image with `nc`, the script prints one result line per check: `--network=pasta:--no-map-gw,--ipv4-only` (a host loopback listener opened by the script is unreachable through the gateway; reachable with `--map-gw`), `--userns=keep-id:uid=10001,gid=10001` file ownership, the exact `--mount` option spelling for `ro`, `nosuid`, `nodev`, `bind-propagation` and `relabel`, `--timeout` ends a container, `--http-proxy=false` hides `HTTP_PROXY`, `--no-hosts`, `--log-driver=none` with `-i`, SELinux mode (`getenforce`) and whether a `relabel=shared` worktree is writable from two containers at once, and the timing of `podman stop -t 2` then `rm -f --ignore`
    - _Requirements: 4.1, 5.7, 7.1, 10.1, 10.5_
  - [x] 0.2 Write `spikes/acp/src/s12-kiro-auth.ts`
    - Starts `kiro-cli acp --agent <profile>` inside the real image with the auth dir staged into a tmpfs `$HOME` and a read-only root, no `KIRO_API_KEY`; prints `currentModeId` and whether one prompt answered; at most two prompts in total
    - _Requirements: 5.6, 6.4_
  - [x] 0.3 Add `apps/runner/src/sandbox/flags.ts` holding every pinned Podman spelling as exported constants (mount option names, relabel values, network value, userns value, tmpfs options), with the initial values from `design.md` "The generated command"
    - A later change of spelling after the spike results is a one-file edit
    - _Requirements: 4.1, 4.3, 5.2, 5.7, 7.1_
  - [x] 0.4 **Done 2026-11-09 on EC2, all PASS (FINDINGS S12).** Was waiting on the deploy-aws spike (`deploy/spike-s12.sh`, spec `deploy-aws` task 1). **Run on EC2 (operator step, blocks nothing):** run `pnpm --filter @seance/spike-acp s12` and `s12-auth` on an EC2 instance with Podman 5 (SELinux enforcing if the AMI allows it), record the results in `spikes/acp/FINDINGS.md` section S12, adjust `flags.ts` if a spelling differs
    - _Requirements: 4.1, 5.7, 7.1_

- [x] 1. Configuration and production guard
  - [x] 1.1 Parse `SEANCE_SANDBOX` and the podman variables in `config.ts`
    - `SandboxConfig` union, strict regexes for memory, cpus, pids, timeout and egress probes; image pinned by digest; `SEANCE_SANDBOX_AUTH_DIR` required; `KIRO_API_KEY` not a credential source in podman mode (logged once when set); headless refusal; forbidden characters in paths and image; log once that `SEANCE_KIRO_BIN` is ignored in podman mode
    - Realpath and directory check for the auth dir in `validateRunnerPaths`
    - Tests first in `sandbox-config.test.ts`: a table of valid and invalid values per variable
    - _Requirements: 1.1 to 1.8_
  - [x] 1.2 Add `sandbox/guard.ts` with `assertSandboxForPublic` and tests for all eight combinations; export `assertSandboxForPublic`, `SandboxError` and `SandboxMode` from `apps/runner/src/index.ts`
    - _Requirements: 2.4_
  - [x] 1.3 Parse `IRCD_PUBLIC` in `apps/ircd/src/index.ts`; any value other than unset, empty, `0` or `1` stops startup with a message naming the variable; call the guard before any listener; pass `publicDeployment` to `createRunner`, which repeats the check in `start()`
    - Test: the startup check as a pure function with `IRCD_PUBLIC=1` and no sandbox expects a refusal naming both variables before any listener; a second test for `createRunner` called directly with `publicDeployment` and no sandbox
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - [x] 1.4 Restrict `kiroAgent` to `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` in podman mode (`agent-profile.ts`) with a registry test
    - _Requirements: 4.5_

- [x] 2. Argument builder (pure)
  - [x] 2.1 Add `sandbox/errors.ts` (`SandboxError`, kinds) and `sandbox/podman-args.ts` (`buildPodmanRunArgs`) using the constants of `flags.ts`
    - Fixed flag list in a fixed order; `--mount` values built from validated parts with the relabel option of D21; env forwarding by name with the allowed set (never `KIRO_API_KEY`); limits from config
    - _Requirements: 4.1 to 4.4, 5.1, 5.2, 5.7, 6.1, 6.2, 6.4, 6.5_
  - [x] 2.2 Add `sandbox/paths.ts`: realpath containment checks for the session cwd, the auth dir and the agents dir
    - Refuse the worktree root itself, overlap in either direction, and `/`
    - _Requirements: 5.3, 5.4_
  - [x] 2.3 Write unit tests `podman-args.test.ts` with one full expected argv as a golden example, and `sandbox-paths.test.ts`
    - _Requirements: 12.1_
  - [x] 2.4 Write property tests in `podman-args.property.test.ts`
    - **Property 1: Argv invariants** (`P1 argv invariants`)
    - **Property 2: No extra mounts** (`P2 no extra mounts`)
    - **Property 3: Environment** (`P3 environment and secrets`)
    - **Property 4: Injection resistance** (`P4 injection resistance`)
    - _Requirements: 4.1 to 4.5, 5.1, 5.7, 6.1 to 6.4, 12.2_

- [x] 3. Launcher and fake podman
  - [x] 3.1 Add `apps/runner/test/fixtures/fake-podman` (sh): `--version`, `info --format json`, `image exists`, `run -i` (records flags and its environment names to a file, runs the Fake_Agent), `ps`, `stop`, `rm`, plus switches for each failure (missing binary, old version, not rootless, missing image, probe exit codes 10, 11 and 13, exit 125/126/127, slow start, `rm` failure)
    - _Requirements: 12.3_
  - [x] 3.2 Add `sandbox/launcher.ts`: `preflight`, `quickCheck`, `spec`, `remove`, `sweep`, injectable `PodmanExec`
    - Version parse (5 or newer), rootless check, image check by digest reference, auth dir check, Probe run with an ephemeral host loopback listener closed afterwards and, when `publicDeployment`, the egress probe targets
    - Container names and labels per the glossary; a removal that fails is remembered and retried by the next `sweep`; only names created in this run are removed outside the label sweep
    - _Requirements: 3.1 to 3.6, 7.7, 10.1, 10.3, 10.4, 10.7_
  - [x] 3.3 Write unit tests for each preflight failure kind and for `remove` and `sweep` call sequences against the fake
    - _Requirements: 3.4, 10.1, 10.3, 10.4_

- [x] 4. Checkpoint: `pnpm --filter @seance/runner typecheck` and `pnpm --filter @seance/runner test`

- [x] 5. Harness and runner wiring
  - [x] 5.1 Podman branch in `spawn.ts` and `acp-harness.ts`
    - Process key by nick and cwd; `Proc.containerName`; `openSession` calls `launcher.quickCheck()` first; the podman process gets the allow-listed environment plus `XDG_RUNTIME_DIR` plus forwarded names and never `KIRO_API_KEY`; `session.close()` removes the container; `onExit` removes it and the `exited` event carries the session ids of that container; `terminate` and `hasProcess` iterate over the agent's procs; `dispose` sweeps
    - `none` mode unchanged (existing harness tests stay green)
    - _Requirements: 3.5, 6.2, 6.4, 8.1 to 8.3, 8.5, 8.6, 10.1, 10.2_
  - [x] 5.2 Wire the launcher in `runner.ts`
    - Build, preflight, sweep at start; sweep at shutdown; pass to the harness; `publicDeployment` option; pass `hardened: config.sandbox.mode === "podman"` to `WorktreeManager`; set the host-side commit hook only in podman mode
    - _Requirements: 2.5, 3.1, 9.2, 10.4, 14.1, 14.8_
  - [x] 5.3 Failure notices
    - `SandboxError` to the Human_Op notice in the invite pipeline and in `reviveSession`; reason texts from a fixed table; stderr tail through `stripControls`, `redact`, 200-byte cut; exorcism notice when removal fails
    - _Requirements: 11.1 to 11.6, 10.3_
  - [x] 5.4 Write unit tests with the fake podman in `sandbox-harness.test.ts`
    - Handshake and reply; two channels of one agent give two containers; kick of one leaves the other; hung agent; process exit; a container ended by `--timeout` counts as an exit and the session revives; bogus podman path; image missing; exit 125; start timeout; after any start failure the agent parts the channel, the Invite_Key is released and no session is registered; `KIRO_API_KEY` absent from the recorded environment names and argv
    - _Requirements: 6.4, 8.1 to 8.4, 10.1 to 10.3, 10.5, 11.1 to 11.5_
  - [x] 5.5 Write property tests in `sandbox-lifecycle.property.test.ts`
    - **Property 5: Lifecycle model** (`P5 lifecycle model`)
    - **Property 6: Fail closed** (`P6 fail closed`)
    - _Requirements: 3.6, 10.1, 10.2, 11.1_

- [x] 6. Host git hardening and host-side commits
  - [x] 6.1 Record the git dir and add the hardened git helper in `worktree-manager.ts` (`hardened` option, `--git-dir`, `--work-tree`); extend `createGitRunner` in `git.ts` so a hardened runner adds `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`
    - The git dir is read from `git -C <repo> worktree list --porcelain`, never from files inside the worktree
    - Replace every `["-C", realPath, ...]` call with the helper; non-hardened output stays byte-identical (existing worktree tests stay green)
    - _Requirements: 9.1, 9.2_
  - [x] 6.2 Verify and restore the `.git` file in `guardBeforePrompt`; on mismatch restore it without following symlinks, reset the worktree and return `{ ok: false, paths: [".git"] }` so the existing notification path reports it
    - _Requirements: 9.3, 9.4_
  - [x] 6.3 Write the failing-first test in `worktree-hardening.test.ts`: rewrite `.git` to a directory whose config sets `core.fsmonitor` to a marker-writing script; assert no marker after the guard (and that the same test fails against the non-hardened manager)
    - _Requirements: 9.5_
  - [x] 6.4 Add `WorktreeManager.commitTurn` and `worktree/turn-committer.ts`; add the `afterTurn` hook to `Session` and `ChannelSessionDeps.commitTurn` to `buildChannelSession`; add the `committed` ChanServ text to `services/notices.ts`
    - _Requirements: 14.1 to 14.7_
  - [x] 6.5 Write `turn-commit.test.ts` against a temporary repository: the cases of Requirement 12.7, including a `pre-commit` hook in the repository that writes a marker and must not run
    - _Requirements: 12.7, 14.1 to 14.8_

- [x] 7. Checkpoint: `pnpm --filter @seance/runner build`, then `pnpm --filter @seance/ircd typecheck` and `pnpm --filter @seance/ircd test`

- [x] 8. Image files, network rule and real-Podman integration
  - [x] 8.1 Add `sandbox/Dockerfile` (base pinned by digest), `sandbox/seance-entry`, `sandbox/seance-probe` (POSIX sh) and the test image `apps/runner/test/fixtures/sandbox/Dockerfile` (base pinned by digest)
    - _Requirements: 1.8, 3.3, 5.6, 7.7_
  - [x] 8.2 Add `sandbox/seance-sandbox.nft` (the default-deny template of Requirement 7.3, placeholders for user, VPC CIDR and resolver), `sandbox/egress-allow.txt` and `sandbox/seance-egress-refresh`
    - _Requirements: 7.3, 7.6_
  - [x] 8.3 Extend the Fake_Agent with probe actions used only by the sandbox suite: report `/proc/self/status` (`CapEff`, `NoNewPrivs`, `Uid`), try a write to a given path, connect to a host and port, report selected environment variables, run `git rev-parse`
    - Keep the script schema validation and its tests
    - _Requirements: 12.5_
  - [x] 8.4 Add `apps/ircd/test/runner/sandbox.integration.test.ts` with `it.skipIf(!podmanAvailable)`; titles carry the skip reason; a helper builds the test image from the fixture Dockerfile when the base image is present locally and skips otherwise
    - Assertions of R12.5; port 0 listeners, everything closed in `afterEach`, no wall-clock sleeps beyond the container start budget; no image pull
    - _Requirements: 12.4 to 12.6_
  - [x] 8.5 Write `sandbox-files.test.ts`: every `FROM` pinned by digest; `seance-probe` exit codes documented in the script match the launcher's table; the nft template contains the drop rules for `169.254.0.0/16` and `@VPC_CIDR@` before the accept for TCP 443, and ends in a drop
    - _Requirements: 7.3, 12.8_

- [x] 9. Docs
  - [x] 9.1 Update `docs/SANDBOX.md`: decisions, pinned spellings, the `sandbox/` file names, SELinux labels, egress allow-list and refresh, image digest, host-side commits, residual credential risk; keep the "specified, not yet run on Linux" banner until task 0.4 and Notes step 2 have been confirmed
    - _Requirements: 7.8, 13.1_
  - [x] 9.2 Add the variables to the `README.md` runner table; link `docs/SANDBOX.md` from `DESIGN.md` §8; record the process-model change and the commit decision
    - _Requirements: 13.2_
  - [x] 9.3 Add a test-free check: run a case-insensitive search for the trademarked term (built from two fragments) over the changed files and the spec files; expect no hits
    - _Requirements: 13.3_

- [x] 10. Final checkpoint
  - Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test --force` (or per package) and `pnpm --filter @seance/web test:e2e` with `SEANCE_SANDBOX` unset; the real-Podman suite must report as skipped on a host without Podman

## Notes

- Every test sub-task is a required step in this plan; design properties P1 to P4 are in 2.4 and P5, P6 in 5.5.
- Operator steps on a Linux host with Podman 5, recorded in `spikes/acp/FINDINGS.md` (section S12): (1) task 0.4; (2) run `sandbox.integration.test.ts` and confirm it passes, then remove the banner of `docs/SANDBOX.md`; (3) on the EC2 instance, render and load `sandbox/seance-sandbox.nft`, run `sandbox/seance-egress-refresh`, run `seance-probe` and confirm exit 11 without the rule and 0 with it, and exit 13 for `1.1.1.1:443` without the default deny; (4) start with `IRCD_PUBLIC=1` and no sandbox (expect refusal), then with the sandbox, invite `coder`, give it `+o`, let it edit a file, check the host commit, `/kick` it and confirm `podman ps -a` is empty.
- Tasks 2.1 to 2.4 use the constants of task 0.3, so a spelling change after the spike touches one file.
- The headless harness is refused in podman mode (task 1.1); no task adds a sandboxed headless path.
- Root `pnpm typecheck` and `pnpm test` may time out under turbo; per-package runs are acceptable. Tests use `ManualClock` or fake timers and bind sockets to port 0.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1", "0.2", "0.3", "1.1", "3.1", "6.1", "8.1", "8.2", "8.3"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.1", "6.2", "6.4", "8.5"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.3", "2.4", "6.3", "6.5"] },
    { "id": 3, "tasks": ["3.2"] },
    { "id": 4, "tasks": ["3.3", "5.1", "5.3"] },
    { "id": 5, "tasks": ["5.2"] },
    { "id": 6, "tasks": ["5.4", "5.5", "8.4"] },
    { "id": 7, "tasks": ["9.1", "9.2"] },
    { "id": 8, "tasks": ["9.3"] },
    { "id": 9, "tasks": ["0.4"] }
  ]
}
```

## Review fixes (2026-11-08, Requirement 15)

- [x] 11. Nested git: `scanConfig` reports nested `.git` and `.gitmodules`; hardened prefix with fsmonitor, untracked-cache and submodule overrides; `status --ignore-submodules=all`; two-turn PoC in `turn-commit.test.ts` (red without the scan change)
- [x] 12. `AcpHarness.openSession`: in-flight map per (agent, cwd), refusal when a container is still registered
- [x] 13. `AcpHarness.dispose`: reject new opens, retire containers of opens in flight, refuse a late session; tests with the fake podman
- [x] 14. Probe runs in every podman start; `SEANCE_SANDBOX_BLOCKED_CIDRS` and `sandbox/cidr.ts`
- [x] 15. `sha256` build arg in `sandbox/Dockerfile`; `noexec` on `$HOME` documented and added to the S12 auth spike; DNS tunnelling in `docs/SANDBOX.md`
- [x] 16. Cleanups: stacked JSDoc in `spawn.ts`, unused `forget()`, sweep lists names and forgets them

## Closing review items (2026-11-08, Requirement 15.7, 15.8)

- [x] 17. `noexec` on `/home/agent` in `flags.ts`; `SEANCE_SANDBOX_KIRO_BIN` validated (`sandbox/kiro-bin.ts`) and passed as `SEANCE_KIRO_BIN`; podman-args, config and file tests
- [x] 18. `PublicEgressError`: public podman requires `SEANCE_SANDBOX_BLOCKED_CIDRS`, in `apps/ircd` and `runner.start()`; probe documented as best effort
- [x] 19. Second concurrent `openSession` for one (agent, cwd) is rejected, never shares the first session; concurrency tests
- [x] 20. README and `docs/SANDBOX.md`: `.gitmodules` and nested `.git` refused by design; `ensure` test

## Demo blocker (2026-11-10, Requirement 16)

- [x] 21. Node and npm in the image; the agent knows the worktree has no git metadata
  - [x] 21.1 `sandbox/Dockerfile`: `node` stage pinned by the test image's digest, `COPY --from` of `node` and the npm files, `npm` and `npx` links recreated (no corepack, see 21.3), setuid strip moved after the last copy, npm offline settings (also in the test image); `docs/SANDBOX.md` section on the image and on git without metadata; tests in `apps/runner/test/sandbox-files.test.ts`; real-Podman case (`npm` probe in the Fake_Agent) in `apps/ircd/test/runner/sandbox.integration.test.ts`
    - _Requirements: 16.1 to 16.6_
  - [x] 21.2 One mode-neutral git rule (decided 2026-11-10, D24): `agents/.kiro/agents/coder.json` and the `seance-fix-and-commit` skill say run `npm test`, commit with git as usual, and treat "not a git repository" as the Podman sandbox where the runner commits as `<agent>: turn in <channel>` (no repair, no install requests, one line saying the runner will commit); `scripts/demo-journey.py` asks for `npm test` and a commit "the runner commits for you" and also accepts ChanServ's `coder committed <sha>`; tests in `sandbox-files.test.ts`; `docs/SANDBOX.md`. No runner or ircd source change
    - WHOIS `tools:` text: decided not to change. It comes from the agent profile and is shared by both modes; `commits by runner` would be false with `SEANCE_SANDBOX=none`
    - _Requirements: 16.4, 17.1 to 17.5_
  - [x] 21.3 Build fix (verified on the deployed host): the pinned `node:26-bookworm-slim` holds only npm under `/usr/local/lib/node_modules` (Node 25+ dropped corepack), so the corepack `COPY` broke `deploy/bootstrap.sh`'s image build. Removed the corepack `COPY`, link and both corepack variables from `sandbox/Dockerfile` and the test image; node, npm and npx unchanged; `sandbox-files.test.ts` expects the two COPY lines and no corepack mention; docs and spec text updated; `seance-fix-and-commit` SKILL.md blank lines restored (wording unchanged)
    - _Requirements: 16.1, 16.4_
  - [x] 21.4 Build fix (verified on the deployed host, 9ec096e): `node --version` in the image failed with "libatomic.so.1: cannot open shared object file" because bookworm-slim lacks it and the test image (built on the node image) has it. `libatomic1` added to the apt line of `sandbox/Dockerfile` with a comment (libstdc++6 and libgcc-s1 already come with bookworm-slim; checked by reasoning, not by `ldd`, as no container runtime was available here), plus a build-time `node --version && npm --version`. `deploy/bootstrap.sh` `build_images` now hashes `sandbox/` plus the kiro-cli sha into the label `io.seance.context-sha`, reuses the image only on a match, otherwise rebuilds ("agent image rebuilt: sandbox context changed") and restarts `seance-ircd` when running; tests in `sandbox-files.test.ts`; docs
    - _Requirements: 16.7, 16.8_
