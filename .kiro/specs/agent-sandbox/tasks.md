# Implementation Plan: agent-sandbox

## Overview

Spike scripts and pinned flag spellings first, then pure code (config, guard, argument builder), then the launcher with a fake podman, the harness and runner wiring, host git hardening, the image files and the real-Podman integration suite, and the docs. Each property test carries its design ID (`P1` to `P6`) in its name. Verify per package (`pnpm --filter @seance/runner typecheck`, `pnpm --filter @seance/runner test`); root turbo runs may time out here. Rebuild the runner (`pnpm --filter @seance/runner build`) before ircd tests that import `@seance/runner`. `SEANCE_SANDBOX=none` must keep every existing test green without change. Never delete a test to make it pass. Fixing a bug starts with a failing test. No new npm dependency. Tasks are coding-only: running the spike scripts and the real-Podman suite on a Linux host is an operator step described in the Notes.

## Tasks

- [ ] 0. Spike S12 scripts and pinned flag spellings
  - [ ] 0.1 Write `spikes/acp/src/s12-podman.ts` and a `s12` script in `spikes/acp/package.json`
    - Using a throwaway image with `nc`, the script prints one result line per check: `--network=pasta:--no-map-gw,--ipv4-only` (a host loopback listener opened by the script is unreachable through the gateway; reachable with `--map-gw`), `--userns=keep-id:uid=10001,gid=10001` file ownership, the exact `--mount` option spelling for `ro`, `nosuid`, `nodev` and `bind-propagation`, `--timeout` ends a container, `--http-proxy=false` hides `HTTP_PROXY`, `--no-hosts`, `--log-driver=none` with `-i`, and the timing of `podman stop -t 2` then `rm -f --ignore`
    - _Requirements: 4.1, 7.1, 10.1, 10.5_
  - [ ] 0.2 Write `spikes/acp/src/s12-kiro-auth.ts`
    - Starts `kiro-cli acp --agent <profile>` inside the real image with the auth dir staged into a tmpfs `$HOME` and a read-only root, then `KIRO_API_KEY` only; prints `currentModeId` and whether one prompt answered; at most two prompts in total
    - _Requirements: 5.6, 6.1_
  - [ ] 0.3 Add `apps/runner/src/sandbox/flags.ts` holding every pinned Podman spelling as exported constants (mount option names, network value, userns value, tmpfs options), with the initial values from `design.md` "The generated command"
    - A later change of spelling after the spike results is a one-file edit
    - _Requirements: 4.1, 4.3, 5.2, 7.1_

- [ ] 1. Configuration and production guard
  - [ ] 1.1 Parse `SEANCE_SANDBOX` and the podman variables in `config.ts`
    - `SandboxConfig` union, strict regexes for memory, cpus, pids, timeout; credential-source rule; headless refusal; forbidden characters in paths and image; log once that `SEANCE_KIRO_BIN` is ignored in podman mode
    - Realpath and directory check for the auth dir in `validateRunnerPaths`
    - Tests first in `sandbox-config.test.ts`: a table of valid and invalid values per variable
    - _Requirements: 1.1 to 1.7_
  - [ ] 1.2 Add `sandbox/guard.ts` with `assertSandboxForPublic` and tests for all eight combinations; export `assertSandboxForPublic`, `SandboxError` and `SandboxMode` from `apps/runner/src/index.ts`
    - _Requirements: 2.4_
  - [ ] 1.3 Parse `IRCD_PUBLIC` in `apps/ircd/src/index.ts`; any value other than unset, empty, `0` or `1` stops startup with a message naming the variable; call the guard before any listener; pass `publicDeployment` to `createRunner`, which repeats the check in `start()`
    - Test: process-level test that runs the startup logic with `IRCD_PUBLIC=1` and no sandbox and expects exit 1 with both variable names and no listener; a second test for `createRunner` called directly with `publicDeployment` and no sandbox
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - [ ] 1.4 Restrict `kiroAgent` to `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` in podman mode (`agent-profile.ts`) with a registry test
    - _Requirements: 4.5_

- [ ] 2. Argument builder (pure)
  - [ ] 2.1 Add `sandbox/errors.ts` (`SandboxError`, kinds) and `sandbox/podman-args.ts` (`buildPodmanRunArgs`) using the constants of `flags.ts`
    - Fixed flag list in a fixed order; `--mount` values built from validated parts; env forwarding by name with the allowed set; limits from config
    - _Requirements: 4.1 to 4.4, 5.1, 5.2, 6.1, 6.2, 6.5_
  - [ ] 2.2 Add `sandbox/paths.ts`: realpath containment checks for the session cwd, the auth dir and the agents dir
    - Refuse the worktree root itself, overlap in either direction, and `/`
    - _Requirements: 5.3, 5.4_
  - [ ] 2.3 Write unit tests `podman-args.test.ts` with one full expected argv as a golden example, and `sandbox-paths.test.ts`
    - _Requirements: 12.1_
  - [ ] 2.4 Write property tests in `podman-args.property.test.ts`
    - **Property 1: Argv invariants** (`P1 argv invariants`)
    - **Property 2: No extra mounts** (`P2 no extra mounts`)
    - **Property 3: Environment** (`P3 environment and secrets`)
    - **Property 4: Injection resistance** (`P4 injection resistance`)
    - _Requirements: 4.1 to 4.5, 5.1, 6.1 to 6.4, 12.2_

- [ ] 3. Launcher and fake podman
  - [ ] 3.1 Add `apps/runner/test/fixtures/fake-podman` (sh): `--version`, `info --format json`, `image exists`, `run -i` (records flags to a file, runs the Fake_Agent), `ps`, `stop`, `rm`, plus switches for each failure (missing binary, old version, not rootless, missing image, probe exit codes 10 and 11, exit 125/126/127, slow start, `rm` failure)
    - _Requirements: 12.3_
  - [ ] 3.2 Add `sandbox/launcher.ts`: `preflight`, `quickCheck`, `spec`, `remove`, `sweep`, injectable `PodmanExec`
    - Version parse (5 or newer), rootless check, image check, auth dir check, Probe run with an ephemeral host loopback listener closed afterwards
    - Container names and labels per the glossary; a removal that fails is remembered and retried by the next `sweep`; only names created in this run are removed outside the label sweep
    - _Requirements: 3.1 to 3.6, 10.1, 10.3, 10.4, 10.7_
  - [ ] 3.3 Write unit tests for each preflight failure kind and for `remove` and `sweep` call sequences against the fake
    - _Requirements: 3.4, 10.1, 10.3, 10.4_

- [ ] 4. Checkpoint: `pnpm --filter @seance/runner typecheck` and `pnpm --filter @seance/runner test`

- [ ] 5. Harness and runner wiring
  - [ ] 5.1 Podman branch in `spawn.ts` and `acp-harness.ts`
    - Process key by nick and cwd; `Proc.containerName`; `openSession` calls `launcher.quickCheck()` first; the podman process gets the allow-listed environment plus `XDG_RUNTIME_DIR` plus forwarded names; `session.close()` removes the container; `onExit` removes it; `terminate` and `hasProcess` iterate over the agent's procs; `dispose` sweeps
    - `none` mode unchanged (existing harness tests stay green)
    - _Requirements: 3.5, 6.2, 8.1 to 8.3, 8.5, 8.6, 10.1, 10.2_
  - [ ] 5.2 Wire the launcher in `runner.ts`
    - Build, preflight, sweep at start; sweep at shutdown; pass to the harness; `publicDeployment` option; pass `hardened: config.sandbox.mode === "podman"` to `WorktreeManager`
    - _Requirements: 2.5, 3.1, 9.2, 10.4_
  - [ ] 5.3 Failure notices
    - `SandboxError` to the Human_Op notice in the invite pipeline and in `reviveSession`; reason texts from a fixed table; stderr tail through `stripControls`, `redact`, 200-byte cut; exorcism notice when removal fails
    - _Requirements: 11.1 to 11.6, 10.3_
  - [ ] 5.4 Write unit tests with the fake podman in `sandbox-harness.test.ts`
    - Handshake and reply; two channels of one agent give two containers; kick of one leaves the other; hung agent; process exit; a container ended by `--timeout` counts as an exit and the session revives; bogus podman path; image missing; exit 125; start timeout; after any start failure the agent parts the channel, the Invite_Key is released and no session is registered
    - _Requirements: 8.1 to 8.4, 10.1 to 10.3, 10.5, 11.1 to 11.5_
  - [ ] 5.5 Write property tests in `sandbox-lifecycle.property.test.ts`
    - **Property 5: Lifecycle model** (`P5 lifecycle model`)
    - **Property 6: Fail closed** (`P6 fail closed`)
    - _Requirements: 3.6, 10.1, 10.2, 11.1_

- [ ] 6. Host git hardening
  - [ ] 6.1 Record the git dir and add the hardened git helper in `worktree-manager.ts` (`hardened` option, `--git-dir`, `--work-tree`); extend `createGitRunner` in `git.ts` so a hardened runner adds `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`
    - The git dir is read from `git -C <repo> worktree list --porcelain`, never from files inside the worktree
    - Replace every `["-C", realPath, ...]` call with the helper; non-hardened output stays byte-identical (existing worktree tests stay green)
    - _Requirements: 9.1, 9.2_
  - [ ] 6.2 Verify and restore the `.git` file in `guardBeforePrompt`; on mismatch restore it without following symlinks, reset the worktree and return `{ ok: false, paths: [".git"] }` so the existing notification path reports it
    - _Requirements: 9.3, 9.4_
  - [ ] 6.3 Write the failing-first test in `worktree-hardening.test.ts`: rewrite `.git` to a directory whose config sets `core.fsmonitor` to a marker-writing script; assert no marker after the guard (and that the same test fails against the non-hardened manager)
    - _Requirements: 9.5_

- [ ] 7. Checkpoint: `pnpm --filter @seance/runner build`, then `pnpm --filter @seance/ircd typecheck` and `pnpm --filter @seance/ircd test`

- [ ] 8. Image files and real-Podman integration
  - [ ] 8.1 Add `sandbox/Containerfile`, `sandbox/seance-entry`, `sandbox/seance-probe` (POSIX sh, shellcheck-clean) and the test image `apps/runner/test/fixtures/sandbox/Containerfile`
    - _Requirements: 5.6, 3.3_
  - [ ] 8.2 Add `sandbox/seance-sandbox.nft`, the nftables rule template of `docs/SANDBOX.md` (drop `169.254.0.0/16` for the runner's Unix user), with the user name as a placeholder
    - _Requirements: 7.3_
  - [ ] 8.3 Extend the Fake_Agent with probe actions used only by the sandbox suite: report `/proc/self/status` (`CapEff`, `NoNewPrivs`, `Uid`), try a write to a given path, connect to a host and port, report selected environment variables, run `git rev-parse`
    - Keep the script schema validation and its tests
    - _Requirements: 12.5_
  - [ ] 8.4 Add `apps/ircd/test/runner/sandbox.integration.test.ts` with `it.skipIf(!podmanAvailable)`; titles carry the skip reason; a helper builds the test image from the fixture Containerfile when the base image is present locally and skips otherwise
    - Assertions of R12.5; port 0 listeners, everything closed in `afterEach`, no wall-clock sleeps beyond the container start budget; no image pull
    - _Requirements: 12.4 to 12.6_

- [ ] 9. Docs
  - [ ] 9.1 Update `docs/SANDBOX.md`: spike results, pinned spellings, the `sandbox/` file names; keep the "specified, not yet implemented" banner until the Notes step 2 has been confirmed
    - _Requirements: 13.1_
  - [ ] 9.2 Add the variables to the `README.md` runner table; link `docs/SANDBOX.md` from `DESIGN.md` §8; record the process-model change and Open Point 1
    - _Requirements: 13.2_
  - [ ] 9.3 Add a test-free check: run a case-insensitive search for the trademarked term (built from two fragments) over the changed files and the spec files; expect no hits
    - _Requirements: 13.3_

- [ ] 10. Final checkpoint
  - Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test --force` (or per package) with `SEANCE_SANDBOX` unset; the real-Podman suite must report as skipped on a host without Podman

## Notes

- Every test sub-task is a required step in this plan; design properties P1 to P4 are in 2.4 and P5, P6 in 5.5.
- Operator steps (not coding tasks), done on a Linux host with Podman 5 and recorded in `spikes/acp/FINDINGS.md` (section S12): (1) run the `s12` scripts of tasks 0.1 and 0.2 and adjust `flags.ts` if a spelling differs; (2) run `sandbox.integration.test.ts` and confirm it passes, then remove the banner of `docs/SANDBOX.md`; (3) on a cloud VM, load `sandbox/seance-sandbox.nft`, run `seance-probe` and confirm exit 11 without the rule and 0 with it; (4) start with `IRCD_PUBLIC=1` and no sandbox (expect refusal), then with the sandbox, invite `coder`, `/kick` it and confirm `podman ps -a` is empty.
- Tasks 2.1 to 2.4 use the constants of task 0.3, so a spelling change after the spike touches one file.
- The headless harness is refused in podman mode (task 1.1); no task adds a sandboxed headless path.
- Open Point 1 of `design.md` (no `git commit` inside the sandbox) is not solved here; the recommendation is to ship public mode without agent commits first.
- Root `pnpm typecheck` and `pnpm test` may time out under turbo; per-package runs are acceptable. Tests use `ManualClock` or fake timers and bind sockets to port 0.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1", "0.2", "0.3", "1.1", "3.1", "6.1", "8.1", "8.2", "8.3"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.1", "6.2"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.3", "2.4", "6.3"] },
    { "id": 3, "tasks": ["3.2"] },
    { "id": 4, "tasks": ["3.3", "5.1", "5.3"] },
    { "id": 5, "tasks": ["5.2"] },
    { "id": 6, "tasks": ["5.4", "5.5", "8.4"] },
    { "id": 7, "tasks": ["9.1", "9.2"] },
    { "id": 8, "tasks": ["9.3"] }
  ]
}
```
