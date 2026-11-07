# Agent sandbox (rootless Podman)

> **Status: specified, not yet implemented.** This document describes the behaviour defined in `.kiro/specs/agent-sandbox`. Nothing here has been run: Podman is not installed on the development machine, and spike S12 (flag spelling, pasta behaviour, Kiro with staged credentials) is still open. Remove this banner when task 8.4 of the spec has passed on a Linux host.

Séance lets AI agents act on a codebase from a chat channel. With `SEANCE_SANDBOX=podman` every `kiro-cli` agent process runs inside a rootless Podman container. Without it (`none`, the default) agents run as plain processes of the runner's Unix user, which is fine on a laptop and not fine on a public server.

## What it protects, and what it does not

| Protects | Does not protect |
|---|---|
| Host files outside one channel worktree (read-only root, three mounts) | The Kiro credential. The agent needs it, so a prompt-injected agent can read and send it |
| Other channels' worktrees and the repository's git state | Which internet hosts the agent can reach |
| Host services on `127.0.0.1` | Services on private networks the host can reach (use a destination allow-list) |
| The cloud metadata endpoint, when the host rule below is in place | Disk space in the worktree (no quota) |
| Privilege escalation inside the container (no capabilities, `no-new-privileges`, non-root) | Kernel or runtime vulnerabilities in Podman, `crun` or the kernel |

The sandbox is one layer. The permission rules (`+o` to write, paths confined to the worktree) and the untrusted-input wrapper still apply.

## Modes and the production rule

| `SEANCE_SANDBOX` | Meaning |
|---|---|
| `none` (default) | Agents run on the host. For local development |
| `podman` | Agents run in containers as described here |

With `IRCD_PUBLIC=1` and `SEANCE_RUNNER=1`, the server refuses to start unless `SEANCE_SANDBOX=podman`. The check runs in `apps/ircd` before any port is opened and again in `runner.start()`.

macOS and Windows are not supported in podman mode. Develop with `none`; run `podman` on a Linux server.

## Variables (podman mode)

| Variable | Default | Rule |
|---|---|---|
| `SEANCE_SANDBOX` | `none` | `none` or `podman` |
| `SEANCE_SANDBOX_IMAGE` | none, required | Local image name. Never pulled. No comma, quote, NUL, CR, LF; must not start with `-` |
| `SEANCE_PODMAN_BIN` | `podman` | Path or name of the Podman binary |
| `SEANCE_SANDBOX_AUTH_DIR` | unset | Existing directory with the Kiro login state (on Linux, `~/.local/share/kiro-cli`). Mounted read-only |
| `KIRO_API_KEY` | unset | Alternative to the auth dir. At least one of the two is required |
| `SEANCE_SANDBOX_MEMORY` | `2g` | `^[1-9][0-9]*[kmg]$`. Memory and swap limit |
| `SEANCE_SANDBOX_CPUS` | `2` | Decimal greater than 0, at most 64 |
| `SEANCE_SANDBOX_PIDS` | `256` | Integer 16 to 4096 |
| `SEANCE_SANDBOX_TIMEOUT_S` | `86400` | Integer 60 to 604800. Hard lifetime of a container |
| `SEANCE_SANDBOX_KIRO_BIN` | `kiro-cli` | Command name inside the image. `SEANCE_KIRO_BIN` is ignored in this mode |
| `IRCD_PUBLIC` | unset | `1` marks a public deployment |

`SEANCE_HARNESS=headless` is refused in podman mode.

## What runs

One container per agent and per session directory. An agent invited into two channels has two containers; kicking it from one stops only that one.

Flags (all always present, each once):

```
--read-only  --cap-drop=ALL  --security-opt=no-new-privileges
--pids-limit  --memory  --memory-swap  --cpus
--user=10001:10001  --userns=keep-id:uid=10001,gid=10001
--pull=never  --http-proxy=false  --no-hosts  --log-driver=none
--timeout  --stop-timeout=2  --network=pasta:--no-map-gw,--ipv4-only
--tmpfs /tmp (noexec)  --tmpfs /home/agent
```

Never present: `--privileged`, `--cap-add`, `--device`, `-v`, `--network=host`, `--pid`, `--env-file`, published ports.

Mounts, and only these:

| Host | Container | Mode |
|---|---|---|
| the session directory (`workspaces/<channel>`) | same path | read-write |
| `SEANCE_AGENTS_DIR` | same path | read-only |
| `SEANCE_SANDBOX_AUTH_DIR` | `/run/seance/auth` | read-only |

The agents directory is mounted because Kiro looks up `--agent <name>` in its working directory. It holds profiles, not secrets. The image entrypoint copies the auth directory into the container's tmpfs `$HOME` before `kiro-cli` starts; nothing is written back.

Environment: `HOME=/home/agent`, `TMPDIR=/tmp`, `LANG`, `LC_*`, `TERM` and `KIRO_API_KEY` (when set), forwarded by name so values never show up in `ps`. The host `PATH`, `HOME` and `TMPDIR` are not forwarded. Proxy variables are not forwarded (`--http-proxy=false`).

ACP stays newline-delimited JSON-RPC on stdio, carried by `podman run -i`.

### Git inside the sandbox

The container has no git metadata, so `git` there reports "not a repository" and an agent cannot commit. This is deliberate (spec `agent-sandbox`, decision D3 and Open Point 1): mounting the repository's git directories would expose state shared by all channels. On the host, the runner runs git with an explicit `--git-dir` and `--work-tree` and checks the worktree's `.git` file before every prompt, because that file is writable by the agent.

## Network

The container gets rootless `pasta` networking:

- Internet access works (Kiro needs AWS).
- `--no-map-gw` stops the container from reaching the host's `127.0.0.1` through its default gateway. Without it, pasta maps the gateway address to the host loopback by default.
- IPv4 only.
- No ports are published.

### Block the metadata endpoint on the host

Rootless Podman cannot filter by destination, and pasta opens outbound sockets on the host side, so the rule has to live on the host and match the Unix user that runs the runner (and therefore pasta). Run the runner as a dedicated user that does not need instance credentials, then add:

```
table inet seance_sandbox {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid "seance" ip daddr 169.254.0.0/16 drop
  }
}
```

(Replace `seance` with the user name. Untested here; confirm with spike S12 task 0.3.) On AWS, a hop limit of 1 on the metadata service does not help, because the connection starts on the host.

If you can, also add an allow-list of destination networks for that user, so agents cannot reach private addresses of your VPC.

### Verify at every start

At startup the runner starts a short container from your image and runs `seance-probe`. It fails the start when the container can reach a throw-away listener on the host's `127.0.0.1` (exit 10) or `169.254.169.254:80` (exit 11). A pass on a machine that is not in a cloud means "not reachable now", not "blocked by a rule".

## Image contract

Build the image from `sandbox/Containerfile` (added by the spec). It must provide:

- a non-root user with uid 10001 and home `/home/agent`;
- the `kiro-cli` binary (you add it to the build context; check its licence terms before you redistribute an image);
- `ENTRYPOINT` `seance-entry`, which stages `/run/seance/auth` into `$HOME/.local/share/kiro-cli` when present and then runs `kiro-cli "$@"`, so `acp --agent <name>` works;
- `seance-probe` and a netcat (`nc`);
- no setuid binaries you do not need. Pin the base image by digest.

The runner never pulls images. Load or build the image on the host first.

## Lifecycle

| Event | What happens |
|---|---|
| Invite | Quick checks (Podman version, image), then `podman run -i`; `session/new` must answer within 30 s |
| `/kick`, the agent's `PART`, quit | Exorcism ends with `podman stop -t 2` and `podman rm -f --ignore` on that container |
| Agent exits or hangs | The container is removed the same way; sessions revive on the next message |
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
| `sandbox image not found` | Build or load `SEANCE_SANDBOX_IMAGE` |
| `container failed to start` | Read the stderr tail in the notice and the runner log |
| `container start timed out` | Check host load and image size |
| `network isolation check failed` | Fix the host loopback or metadata rule |

At boot, the same checks stop the runner and the server exit with a non-zero code.

## Verify a host by hand

```sh
podman --version                                   # 5.x
podman info --format '{{.Host.Security.Rootless}}' # true
podman image exists "$SEANCE_SANDBOX_IMAGE" && echo ok
```

Then start the runner with `SEANCE_SANDBOX=podman`. The start-up probe is the check for the network rules: if the host rule or the pasta flags are wrong, the server refuses to start and names the check that failed (loopback or metadata).

After a `/kick`, `podman ps -a` must list no container for that agent.

## Known limits

- No SELinux relabelling of bind mounts.
- The worktree has no disk quota.
- Podman-in-Podman (running the runner itself in a container) is not supported.
- The Kiro credential is readable by the agent (see the table at the top).
