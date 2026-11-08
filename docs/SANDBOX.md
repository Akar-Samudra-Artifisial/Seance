# Agent sandbox (rootless Podman)

> **Status: implemented, not yet run on Linux.** The behaviour below is built (spec `.kiro/specs/agent-sandbox`) and covered by unit and property tests against a fake Podman. Nothing here has run against a real Podman yet: the development machine is a Mac. Spike S12 (task 0.4, "run on EC2": flag spelling, pasta, SELinux labels, Kiro with staged credentials) and the real-Podman suite `apps/ircd/test/runner/sandbox.integration.test.ts` are still open. Remove this banner when both have passed on a Linux host.

Séance lets AI agents act on a codebase from a chat channel. With `SEANCE_SANDBOX=podman` every `kiro-cli` agent process runs inside a rootless Podman container. Without it (`none`, the default) agents run as plain processes of the runner's Unix user, which is fine on a laptop and not fine on a public server.

## Decisions (2026-11-08)

| Topic | Decision |
|---|---|
| Commits | No git inside the container. The runner commits an op agent's changes on the host after each turn, with hardened git. A commit command for channel ops is a later spec |
| Kiro credentials | Mounted read-only, never placed in an environment. The residual exfiltration risk is below |
| Egress | A host rule blocks `169.254.169.254` and the VPC CIDR and allows only HTTPS to the Kiro endpoints and package registries |
| Spike S12 | Kept as a task marked "run on EC2"; nothing else waits for it |
| Image | Built from `sandbox/Dockerfile`, base and runtime reference pinned by digest |
| SELinux | Enforcing hosts are supported with relabelled bind mounts |

## What it protects, and what it does not

| Protects | Does not protect |
|---|---|
| Host files outside one session directory (read-only root, three mounts) | The Kiro credential. The agent needs it, so a prompt-injected agent can read the staged copy and send it to an allowed host |
| Other channels' worktrees and the repository's git state | Allowed hosts behind a shared CDN: their addresses may also serve other sites. DNS tunnelling: DNS to the resolver must stay open, so an agent can encode data in lookups of names it controls (slow, but a channel out) |
| Host services on `127.0.0.1` | Services you add to the host rule by hand: agents can reach them too |
| The cloud metadata endpoint and the VPC, with the host rule below | Disk space in the worktree (no quota) |
| Privilege escalation inside the container (no capabilities, `no-new-privileges`, non-root) | Kernel or runtime vulnerabilities in Podman, `crun` or the kernel |

The sandbox is one layer. The permission rules (`+o` to write, paths confined to the worktree) and the untrusted-input wrapper still apply.

**Residual credential risk.** The login state in `SEANCE_SANDBOX_AUTH_DIR` is copied into the container's memory-backed `$HOME`, so `kiro-cli` can use and refresh it. A prompt-injected agent can read that copy and send it to any host the egress rule allows (the Kiro endpoints and package registries accept uploads). Use a dedicated, low-privilege login for the public server, keep its spend limited, and rotate it after the event.

## Modes and the production rule

| `SEANCE_SANDBOX` | Meaning |
|---|---|
| `none` (default) | Agents run on the host. For local development |
| `podman` | Agents run in containers as described here |

With `IRCD_PUBLIC=1` and `SEANCE_RUNNER=1`, the server refuses to start unless `SEANCE_SANDBOX=podman`, and in podman mode it refuses to start when `SEANCE_SANDBOX_BLOCKED_CIDRS` is empty (the error names that variable): a public host must say which private ranges its host rule blocks, so the start-up probe can try them. The checks run in `apps/ircd` before any port is opened and again in `runner.start()`. `IRCD_PUBLIC` accepts unset, empty, `0` and `1` only.

macOS and Windows are not supported in podman mode. Develop with `none`; run `podman` on a Linux server.

## Variables (podman mode)

| Variable | Default | Rule |
|---|---|---|
| `SEANCE_SANDBOX` | `none` | `none` or `podman` |
| `SEANCE_SANDBOX_IMAGE` | none, required | `<name>@sha256:<64 hex>`. Never pulled. No comma, quote, NUL, CR, LF |
| `SEANCE_SANDBOX_AUTH_DIR` | none, required | Existing directory with the Kiro login state (on Linux, `~/.local/share/kiro-cli`). Mounted read-only |
| `SEANCE_PODMAN_BIN` | `podman` | Path or name of the Podman binary |
| `SEANCE_SANDBOX_MEMORY` | `2g` | `^[1-9][0-9]*[kmg]$`. Memory and swap limit |
| `SEANCE_SANDBOX_CPUS` | `2` | Decimal greater than 0, at most 64 |
| `SEANCE_SANDBOX_PIDS` | `256` | Integer 16 to 4096 |
| `SEANCE_SANDBOX_TIMEOUT_S` | `86400` | Integer 60 to 604800. Hard lifetime of a container |
| `SEANCE_SANDBOX_KIRO_BIN` | `kiro-cli` | A bare command name found on the image's PATH (`/usr/local/bin`) or an absolute path in the image. Refused under `/home/agent`, `/tmp` and `/run`, which are `noexec` or credential mounts. Passed to the container as `SEANCE_KIRO_BIN`. The host's `SEANCE_KIRO_BIN` is ignored in this mode |
| `SEANCE_SANDBOX_EGRESS_PROBES` | `1.1.1.1:443` | 1 to 8 `<IPv4>:<port>` targets outside the allow-list; the start-up probe fails when one is reachable, in every podman start |
| `SEANCE_SANDBOX_BLOCKED_CIDRS` | unset; required with `IRCD_PUBLIC=1` | 1 to 8 IPv4 CIDRs your host rule blocks (the VPC, other private ranges), same values as `@VPC_CIDR@`. The probe tries the first address after the network address of each on port 443 and fails when it connects. Best effort, see "Verify at every start" |
| `IRCD_PUBLIC` | unset | `1` marks a public deployment |

`KIRO_API_KEY` is never forwarded in podman mode; when it is set, the runner logs a warning once. `SEANCE_HARNESS=headless` is refused in podman mode.

## What runs

One container per agent and per session directory. An agent invited into two channels has two containers; kicking it from one stops only that one. A private `/msg` session gets its own container too.

The flags live in `apps/runner/src/sandbox/podman-args.ts`; every spelling that may differ between Podman versions lives in `apps/runner/src/sandbox/flags.ts`, the one file to edit after spike S12. A generated command:

```
podman run -i --rm --name=seance-coder-1a2b3c4d-9f8e7d6c
  --label=io.seance.sandbox=1 --label=io.seance.workspaces=<16 hex> --label=io.seance.agent=coder
  --read-only --cap-drop=ALL --security-opt=no-new-privileges
  --pids-limit=256 --memory=2g --memory-swap=2g --cpus=2
  --user=10001:10001 --userns=keep-id:uid=10001,gid=10001
  --pull=never --http-proxy=false --no-hosts --log-driver=none
  --timeout=86400 --stop-timeout=2 --hostname=seance-agent --workdir=<agents>
  --network=pasta:--no-map-gw,--ipv4-only
  --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m --tmpfs=/home/agent:rw,nosuid,nodev,noexec,size=256m
  --mount=type=bind,src=<worktree>,dst=<worktree>,rw,bind-propagation=rprivate,nosuid,nodev,relabel=shared
  --mount=type=bind,src=<agents>,dst=<agents>,ro,bind-propagation=rprivate,nosuid,nodev,relabel=shared
  --mount=type=bind,src=<auth>,dst=/run/seance/auth,ro,bind-propagation=rprivate,nosuid,nodev,relabel=shared
  -e HOME=/home/agent -e TMPDIR=/tmp -e LANG -e TERM
  <image>@sha256:<digest> acp --agent coder
```

Never present: `--privileged`, `--cap-add`, `--device`, `-v`, `--network=host`, `--pid`, `--env-file`, `--security-opt label=disable`, published ports.

Mounts, and only these:

| Host | Container | Mode | SELinux label |
|---|---|---|---|
| the channel worktree (`workspaces/<channel>`) | same path | read-write | `:z` (shared: every agent of the channel mounts it) |
| a private session directory (`workspaces/_private/<nick>`) | same path | read-write | `:Z` (private: one container mounts it) |
| `SEANCE_AGENTS_DIR` | same path | read-only | `:z` |
| `SEANCE_SANDBOX_AUTH_DIR` | `/run/seance/auth` | read-only | `:z` |

Why not `:Z` everywhere: a `:Z` label is private to one container, so the second agent of a channel, or any other container reading the agents or auth directory, would be denied. On a host without SELinux, Podman ignores the option.

The agents directory is mounted because Kiro looks up `--agent <name>` in its working directory. It holds profiles, not secrets. It also holds the agents' skills (`.kiro/skills/<name>/SKILL.md`, spec `agent-skills`), so skills are read-only inside the container: an agent can read its skill but never change it, and no skill can come from the worktree, which never holds the target repository's `.kiro`. The image entrypoint copies the auth directory into the container's tmpfs `$HOME` before `kiro-cli` starts; nothing is written back.

Both tmpfs mounts (`/tmp` and `/home/agent`) are `noexec,nosuid,nodev`, so nothing an agent downloads or writes there can be run from there. Everything the container starts lives in the read-only image: `kiro-cli`, `seance-entry` and `seance-probe` are in `/usr/local/bin`. Tools that execute programs from `$HOME` (`npx` and `uvx` caches, for example) do not work in the sandbox by design; run them with `SEANCE_SANDBOX=none` or bake what you need into the image.

Environment: `HOME=/home/agent`, `TMPDIR=/tmp`, `SEANCE_KIRO_BIN` (the validated command, not a secret), `LANG`, `LC_*`, `TERM`, forwarded by name so values never show up in `ps`. The host `PATH`, `HOME`, `TMPDIR` and `KIRO_API_KEY` are not forwarded. Proxy variables are not forwarded (`--http-proxy=false`). The `podman` process itself gets the allow-listed environment plus `XDG_RUNTIME_DIR`, never `KIRO_API_KEY`.

ACP stays newline-delimited JSON-RPC on stdio, carried by `podman run -i`.

## Repositories that are refused by design

A target repository (`SEANCE_TARGET_REPO`) that commits a `.gitmodules` file is refused: `ensure` fails with a `config-exclusion` error naming the path, and no agent starts in that channel. A nested `.git` (a directory, or a `gitdir:` file) is refused wherever it appears in a worktree. Git cannot commit a `.git` path, so in practice it is something an agent creates (`git init sub`, a `git clone`): the scan reports it, nothing is committed, and the next prompt guard removes it and resets the worktree. All of this is deliberate. A nested repository carries its own git config (`core.fsmonitor`, hooks) that is written by whoever controls the files, and the host runs git over the worktree. It holds in `none` mode as well. To use a repository with submodules, remove the submodules (and `.gitmodules`) first, or vendor their contents as plain files.

## Git and host-side commits

The container has no git metadata, so `git` there reports "not a repository". Mounting the repository's git directories would expose state shared by all channels.

On the host, the runner treats the worktree as untrusted input, because the agent can write its `.git` file:

- every git call on a worktree passes `-c core.fsmonitor=false -c core.untrackedCache=false -c submodule.recurse=false`, `--git-dir=<recorded>` and `--work-tree=<worktree>`, with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` set to `/dev/null`; `git status` also passes `--ignore-submodules=all` (`git add` has no such option, so the next rule keeps nested repositories out); the git dir is recorded from the repository side, never read from the worktree;
- a nested repository is refused like `AGENTS.md` and `.kiro`: any `.git` below the worktree root (directory or `gitdir:` file) and any `.gitmodules` make the scan report the path, so nothing is committed and the next prompt guard removes it and resets. A `.git` inside the worktree is agent-controlled config (`core.fsmonitor`, hooks) that host git would otherwise honour. This applies in `none` mode too, and a target repository that itself commits a `.gitmodules` is refused at `ensure`;
- before every prompt the `.git` file is compared with the recorded line; a changed file, a symlink or a directory is restored (temp file and rename, no symlink is followed), the worktree is reset, and the channel ops get the usual "protected config" notice naming `.git`.

After a turn that ends normally, when the agent holds `+o` in the channel, the runner commits the worktree's changes on the channel branch:

- author `<agent> <<agent>@seance.invalid>`, committer `Séance runner <runner@seance.invalid>`, message `<agent>: turn in <channel>` (no agent text);
- hooks off (`core.hooksPath=/dev/null`, `--no-verify`), signing off;
- no commit when nothing changed, when `AGENTS.md`, `.kiro`, a nested `.git` or `.gitmodules` is present, after a cancelled or failed turn, while the session is closing (a `/kick` still discards an unfinished turn), or for a private session;
- the next prompt waits for the commit; on success ChanServ says `coder committed <sha> (<n> files)`, on failure the ops get `coder: commit failed in <channel> (see the runner log)`.

In `none` mode nothing changes: agents commit with their own shell, as before.

## Network

The container gets rootless `pasta` networking:

- `--no-map-gw` stops the container from reaching the host's `127.0.0.1` through its default gateway. Without it, pasta maps the gateway address to the host loopback.
- IPv4 only. No ports are published.

### The host rule (`sandbox/seance-sandbox.nft`)

Rootless Podman cannot filter by destination, and pasta opens outbound sockets on the host side as the runner's Unix user, so the rule lives on the host and matches that user. Run the runner as a dedicated user that does not need instance credentials. The template, in order, for that user:

1. accept established and related traffic;
2. accept DNS to the resolver only (`@RESOLVER@`; on AWS the VPC base + 2 or `169.254.169.253`);
3. drop `169.254.0.0/16` (the metadata endpoint `169.254.169.254` included);
4. drop the VPC CIDR (`@VPC_CIDR@`);
5. accept `127.0.0.0/8` and `::1` (the runner's own local services; containers cannot reach them, see `--no-map-gw`);
6. accept TCP 443 to the addresses in the set `seance_allow4`;
7. drop everything else, IPv4 and IPv6.

```sh
sed -e 's/@RUNNER_USER@/seance/' -e 's|@VPC_CIDR@|10.0.0.0/16|' -e 's/@RESOLVER@/10.0.0.2/' \
  sandbox/seance-sandbox.nft | sudo tee /etc/nftables.d/seance-sandbox.nft >/dev/null
sudo nft -f /etc/nftables.d/seance-sandbox.nft
sudo sandbox/seance-egress-refresh     # then every 10 minutes from a systemd timer
```

If the runner's user needs a service outside loopback (a managed database, for example), add an accept for exactly that address and port before step 7. Agents can then reach it as well.

### The allow-list (`sandbox/egress-allow.txt`)

Host names, one per line: the Kiro service endpoints of your region (`runtime`, `management`, `telemetry` under `<region>.kiro.dev`), the sign-in endpoint used for token refresh, and the package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`). nftables matches addresses, so `seance-egress-refresh` resolves every name and replaces the set in one transaction. Compare the list with [the Kiro firewall page](https://kiro.dev/docs/privacy-and-security/firewalls/) for your region and login method before you deploy; the shipped list has not been checked against a live Kiro session yet (task 0.4).

### Verify at every start

At startup the runner starts a short container from your image and runs `seance-probe`. It fails the start when the container can reach a throw-away listener on the host's `127.0.0.1` through the gateway (exit 10), `169.254.169.254:80` (exit 11), or any `SEANCE_SANDBOX_EGRESS_PROBES` target or an address inside a `SEANCE_SANDBOX_BLOCKED_CIDRS` range (exit 13; default target `1.1.1.1:443`, outside the allow-list). These run on every podman start, not only with `IRCD_PUBLIC=1`, so a Linux development host that lacks the default-deny rule fails the start too: load the rule there, or use a throw-away `SEANCE_SANDBOX_EGRESS_PROBES` you know is unreachable. **The probe is best effort.** A pass means "not reachable now", not "blocked by a rule": a host that does not exist, or does not listen on that port, looks exactly like one the rule drops, and so does a connect that times out for any other reason. The CIDR probe tries `<network>+1:443`, usually a router that never answers, so it passes even without the rule. For a meaningful VPC check add an address you know is live and listening to `SEANCE_SANDBOX_EGRESS_PROBES` (a host you run in the VPC); the probe then fails exactly when the rule is missing. Requiring `SEANCE_SANDBOX_BLOCKED_CIDRS` on a public host makes the operator state the ranges; it does not prove the rule works. After loading the rule, test it by hand from inside a container (`podman run --rm ... nc -z -w 2 <live VPC host> <port>` must fail).

## Image contract

Build the image from `sandbox/Dockerfile`:

```sh
cp "$(command -v kiro-cli)" sandbox/kiro-cli     # you supply the binary; check its licence terms
sha256sum sandbox/kiro-cli                       # compare with the digest Kiro publishes for that version
podman build --build-arg KIRO_CLI_SHA256=<that digest> -t localhost/seance-agent:build -f sandbox/Dockerfile sandbox
podman image inspect --format '{{.Digest}}' localhost/seance-agent:build
export SEANCE_SANDBOX_IMAGE=localhost/seance-agent@<that digest>
```

`sandbox/kiro-cli` is git-ignored. The build fails when `KIRO_CLI_SHA256` is missing or does not match the file, so the binary in the image is the one you checked. The image provides:

- a non-root user with uid 10001 and home `/home/agent`;
- the base image pinned by digest (`debian:bookworm-slim`), setuid bits removed;
- `ENTRYPOINT` `seance-entry`, which stages `/run/seance/auth` into `$HOME/.local/share/kiro-cli` and then runs `kiro-cli "$@"`, so `acp --agent <name>` works;
- `seance-probe`, `nc` (netcat-openbsd), `ca-certificates`, and `git` (so git fails with "not a repository").

The runner never pulls images. Build or load the image on the host first. The test image for the integration suite is `apps/runner/test/fixtures/sandbox/Dockerfile` (the Fake_Agent instead of `kiro-cli`).

## Lifecycle

| Event | What happens |
|---|---|
| Invite | Quick checks (Podman version, image), then `podman run -i`; `initialize` and `session/new` must answer within 25 s |
| Turn ends (`+o` agent) | Host-side commit, then the next prompt |
| `/kick`, the agent's `PART`, quit | Exorcism ends with `podman stop -t 2` and `podman rm -f --ignore` on that container |
| Agent exits or hangs | The container is removed the same way; only that container's sessions close and revive on the next message |
| Runner start and shutdown | Containers with label `io.seance.sandbox=1` and this deployment's `io.seance.workspaces` label are removed |
| Runner killed | Containers end by themselves after `SEANCE_SANDBOX_TIMEOUT_S`, or are swept at the next start |

## When it fails

The agent does not start. No host process is ever used as a fallback. Human operators of the channel get one notice:

```
sandbox: coder not started in #fix-bug-123: <reason>
```

| Reason | Fix |
|---|---|
| `podman not found` | Install Podman 5 or set `SEANCE_PODMAN_BIN` |
| `podman too old (need 5 or newer)` | Upgrade |
| `podman is not rootless` | Run the runner as an unprivileged user |
| `sandbox image not found` | Build or load `SEANCE_SANDBOX_IMAGE` under its digest |
| `container failed to start: <podman stderr>` | The stderr tail is control-stripped, redacted, path-free and at most 200 bytes; the full cause is in the runner log |
| `container start timed out` | Check host load and image size |
| `network isolation check failed` | Fix the pasta flags or load the host rule |

At boot, the same checks stop the runner and the server exits with a non-zero code. A container that cannot be removed is reported to the ops once and retried at the next sweep.

## Verify a host by hand

```sh
podman --version                                   # 5.x
podman info --format '{{.Host.Security.Rootless}}' # true
podman image exists "$SEANCE_SANDBOX_IMAGE" && echo ok
getenforce                                         # Enforcing is supported
```

Then start the runner with `SEANCE_SANDBOX=podman` (and `IRCD_PUBLIC=1` on the public host). The start-up probe is the check for the network rules: if the host rule or the pasta flags are wrong, the server refuses to start and names the check that failed. Invite `coder`, give it `+o`, let it edit a file and check the ChanServ commit line and `git log seance/<channel>`. After a `/kick`, `podman ps -a` must list no container for that agent.

## Known limits

- `/home/agent` and `/tmp` are `noexec`. That `kiro-cli` starts with it (it runs from `/usr/local/bin` of the image and only reads its login from `$HOME`) is expected, not yet observed on Linux: spike S12 (`pnpm --filter @seance/spike-acp s12-auth`, task 0.4) runs it in the production flag set; `S12_HOME_EXEC=1` drops `noexec` for a comparison if it fails. Tools that execute from `$HOME` (`npx`, `uvx` caches) do not work.
- A second `openSession` for an agent and session directory whose open is still in flight is rejected (`a session for <agent> in this session directory is already being opened`); it never receives the first caller's session.
- DNS tunnelling is not prevented (see the table at the top).
- The worktree has no disk quota.
- Podman-in-Podman (running the runner itself in a container) is not supported.
- The Kiro credential is readable by the agent (see "Residual credential risk").
- Several agents in one channel share one worktree; a host-side commit after one agent's turn includes whatever the others changed meanwhile.
