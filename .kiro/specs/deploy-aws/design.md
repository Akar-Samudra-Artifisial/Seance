# Design Document: deploy-aws

## Overview

```
 browser ──HTTPS 443──▶ Caddy (TLS for <eip-dashes>.sslip.io)
                          ├── /      ──▶ 127.0.0.1:3000  seance-web   (next start, user seance)
                          └── /ws    ──▶ 127.0.0.1:6680  seance-ircd  (ircd + runner, user seance)
                                                              │ rootless podman run -i (pasta)
                                                              ▼
                                         agent containers (sandbox/Dockerfile image, by digest)
                                              egress: sandbox/seance-sandbox.nft for user seance
 operator ──SSM Session Manager──▶ shell (no port 22, no key pair)
```

One EC2 instance, everything on it: Caddy, the Next production server, the ircd with the runner, and the agent containers. Terraform owns the AWS side (`infra/`), `deploy/` owns the host. The instance is never replaced for an update: `ami` and `user_data` are ignored after creation, and `deploy/update.sh` moves the checkout.

## Components

### Terraform (`infra/`)

| File | Content |
| --- | --- |
| `versions.tf` | Terraform `>= 1.9`, `hashicorp/aws ~> 6.0`, provider with profile, region, `allowed_account_ids` and `default_tags` |
| `variables.tf` | account, profile, region, sizes, `repo_url`, `git_ref` (validated full sha), `budget_email` (no default), budget thresholds |
| `main.tf` | default VPC and subnet lookups, Debian 13 AMI data source, security group with separate ingress/egress rule resources, Elastic IP + association, IAM role + SSM policy + instance profile, the instance, the workspaces volume + attachment, cost allocation tag, budget |
| `user_data.sh.tftpl` | clone at `git_ref`, verify `HEAD`, run `deploy/bootstrap.sh` with the hostname, volume id and VPC CIDR |
| `outputs.tf` | `instance_id`, `public_ip`, `hostname`, `url`, `ssm_session_command`, `ami` |

### Host (`deploy/`)

| File | Content |
| --- | --- |
| `bootstrap.sh` | idempotent provisioning; ends with the agent gate (D6) |
| `update.sh` | deploy a commit with health check and rollback |
| `spike-s12.sh` | Spike_S12 with a pass/fail table |
| `seance.env.example` | template of `/etc/seance/seance.env`; `bootstrap.sh` fills the placeholders once |
| `Caddyfile` | template of `/etc/caddy/Caddyfile` |
| `systemd/seance-ircd.service`, `seance-web.service` | the two services |
| `systemd/seance-sandbox-nft.service`, `seance-egress-refresh.{service,timer}` | the agents' egress rule and its allow-list refresh |
| `../tools/smoke-wss.mjs` | repeatable wss smoke test (requirement 7.5): login, fresh channel, invite, wait for `worktree ready` and the agent's JOIN, `+v`, one word, KICK, credits line; `SMOKE_SECRET` only |
| `seance-kiro-refresh.sh`, `systemd/seance-kiro-refresh.{service,timer}` | forced Kiro token refresh on a copy, 20 minutes after each run (requirement 5.5); installed to `/usr/local/sbin/seance-kiro-refresh` (root-owned, 0755) and run as `seance` |

## Decisions

- **D1 Debian 13.** Its main repository ships Podman 5 with `passt`; Ubuntu 24.04 has 4.9, below the runner's preflight minimum. The AMI is looked up (owner `136693071363`, `debian-13-amd64-*`, x86_64, hvm, ebs, most recent) and `ami` is in `ignore_changes`, so a new Debian image never replaces the server.
- **D2 Hostname without DNS.** The Elastic IP is allocated before the instance and associated afterwards, so `user_data` can carry `<eip-dashes>.sslip.io` without a dependency cycle. sslip.io resolves the name to the address; Caddy's automatic HTTPS gets a certificate for it on port 80/443.
- **D3 Git as root, build as seance.** `/opt/seance` is owned by `seance`; `pnpm install --frozen-lockfile` and `pnpm build` run as `seance` with `/etc/seance/web.env` loaded (`set -a; . web.env; set +a`), so the client is built for `wss://<host>/ws`. Git runs as root with `safe.directory` and the tree is `chown`ed afterwards, because the egress rule keeps GitHub out of `seance`'s reach. A build as `seance` needs the npm registry and the `next/font` files, so `update.sh` (and `bootstrap.sh` when it has to download) stops the ircd and the egress rule for it and starts both again.
- **D4 Hardening exceptions for the ircd.** Rootless Podman calls the setuid helpers `newuidmap`/`newgidmap` for every container's user namespace, writes `/proc/sys` entries for its containers and manages cgroups through the user manager. `seance-ircd` therefore sets `NoNewPrivileges=no` explicitly (a documented exception) and omits `ProtectKernelTunables` and `ProtectControlGroups`; it keeps `ProtectSystem=strict`, `PrivateTmp`, `ProtectKernelModules` and the container hardening of agent-sandbox (all capabilities dropped, `no-new-privileges` inside the container). A rendered drop-in orders it after `user@<uid>.service`. `seance-web` sets `NoNewPrivileges=yes` and stricter options (`ProtectHome`, `PrivateDevices`, no capabilities).
- **D5 Cgroups.** The runner passes `--memory`, `--cpus` and `--pids-limit`. Rootless cgroup v2 limits need the systemd cgroup manager, a user bus (`dbus-user-session`, linger) and delegated controllers: `bootstrap.sh` writes `Delegate=cpu cpuset io memory pids` for `user@.service` and `cgroup_manager = "systemd"` for `seance`; the units get `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`.
- **D6 Agent gate.** The ircd (and with it every agent) starts only when `kiro-cli whoami` succeeds as `seance`, `/etc/seance/accounts` holds an account and `SEANCE_INVITERS` is set; the public start-up guard would refuse otherwise anyway. Until then `bootstrap.sh` prints the next step and the unit also carries `ConditionDirectoryNotEmpty` on the login directory. The egress rule loads together with the ircd (and earlier in the spike).
- **D7 Kiro login.** Device flow (`kiro-cli login --use-device-flow`) as `seance`, with the egress rule stopped for the login because the device flow's endpoints are not all on the agents' allow-list. No `KIRO_API_KEY` on the host. **Superseded by `sandbox-api-key-auth` (Requirements 1 to 4):** `KIRO_API_KEY` may be set in the runner environment file instead of, or with, the Kiro login; it is forwarded name-only into each agent container, and the login wins when both are set.
- **D8 Workspaces quota.** XFS on the extra volume, mounted with `prjquota`, project 4201 over the whole mount with a hard limit 2 GiB below the volume size; the spike proves enforcement with a temporary 10 MiB project 4299.
- **D9 Agent image.** `bootstrap.sh` pulls the base images named in the two Dockerfiles by their pinned digests, copies the installed `kiro-cli` into a temporary build context, builds `sandbox/Dockerfile` with its sha256 and writes `localhost/seance-agent@<digest>` into the env file. The spike builds the test image from `apps/runner/test/fixtures/sandbox/Dockerfile` through the integration suite.
- **D10 Credit caps.** Daily 100, channel 30, two agent channels, three containers (3 × 768 MiB on 4 GiB), invite rate 3, inviters are the judges' accounts. public-hardening has no per-account counter; spend is bounded per channel and per day for everyone together.
- **D11 Updates.** `update.sh <sha>` as root: fetch, checkout, install, build, re-install the units, restart, check `127.0.0.1:3000/` and (if it ran) `127.0.0.1:6680/healthz`; on failure the previous commit is deployed again and the script exits 1.
- **D12 Costs.** `t3.medium` 30.37, gp3 60 GB 4.80, IPv4 3.65 USD per month; t3 unlimited surplus at 0.05 USD per vCPU-hour above baseline is the main risk. The budget filters on `user:Project$seance`, which needs the activated cost allocation tag; AWS accepts it only after the tag appears in billing data, so the first apply may need a second run a day later.

- **D13 SSM first.** `user_data` installs and starts `amazon-ssm-agent` (official `.deb` from the regional AWS bucket, the Debian image lacks it) before the clone and the bootstrap, so a failed bootstrap never locks the Operator out.
- **D14 Pinned installer.** `deploy/pins.env` pins `KIRO_INSTALLER_SHA256`; a missing or different value stops `bootstrap.sh` (fail closed). The installer verifies the kiro-cli package itself against Kiro's release manifest.
- **D15 Placement and detach.** The subnet comes from a zone that offers the instance type (`aws_ec2_instance_type_offerings`); the AMI filter takes release images only (`debian-13-amd64-20*`); the volume attachment stops the instance before detaching.
- **D17 Kiro login refresh runs as `seance`, never root.** The token directory belongs to `seance`, which the agents can influence; a root job that created a temp file there and then wrote, re-owned or chmod-ed it would follow a link planted by a compromised `seance` and could overwrite any root file. `seance-kiro-refresh.service` therefore sets `User=seance`/`Group=seance` and the script refuses to run as anyone else; it needs no root because the files are already `seance`'s. The unit is hardened (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict` with `ReadWritePaths` on the login directory only, kernel and cgroup protections, `RestrictAddressFamilies`, `UMask=0077`) but has no `ProtectHome`, because it reads `~/.local/bin` and writes the login. The script, in order: `flock -n` on `.refresh.lock` (exit 0 when held); refuse before any network call while the live `data.sqlite3-wal` is non-empty; copy the database with SQLite's backup API into a `mktemp` HOME (no `cp` of a live database); force the refresh on the copy; abort without replacing when the live `expires_at` changed since the start (a manual re-login wins); checkpoint the copy; install with an atomic `mv -f` of a 0600 temp file in the auth directory. The timer uses `OnUnitInactiveSec=20min`, so scheduling continues after a failed run. `update.sh` enables the timer when agents were running, so older installs get it. The script file is root-owned 0755 (`seance` must execute but not edit it).
- **D16 Edge headers and updates.** Caddy adds HSTS (without `includeSubDomains`), `nosniff` and `no-referrer`, and keeps the app's CSP; `unattended-upgrades` installs security updates daily.

## Error handling

- `bootstrap.sh` stops at the first failing step (`set -euo pipefail`, `die` with the reason) and can be run again; every step checks its state.
- The volume wait gives up after 5 minutes with the volume id in the message.
- `update.sh` rolls back on any failure of fetch, install, build or health, and says when the rollback is not healthy either.
- `spike-s12.sh` never stops early: every check produces a row, and the exit code is 1 when one row is FAIL.

## Testing strategy

- CI (`infra` job): `shellcheck --severity=style deploy/*.sh`; `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`, with empty AWS credential variables.
- On the host: Spike_S12 (task 1), the browser smoke test (task 4), the budget alert check (task 5).
- The repository's own checks stay green (`pnpm build`, `typecheck`, `lint`, `test`, `test:e2e`); this spec adds no application code.

## Open points

1. **kiro-cli on Debian.** Kiro documents Fedora, Ubuntu and Amazon Linux; the installer is expected to work on Debian 13 (glibc, x86_64) but this is first confirmed by the spike host. The installer is pinned by sha256 in `deploy/pins.env` (D14).
2. **Allow-list for token refresh.** The agents refresh the Kiro token from inside the container; `sandbox/egress-allow.txt` must contain the sign-in endpoints of the account's login method (agent-sandbox open point). Checked by the smoke test and `spike-s12.sh --with-auth`.
3. **Classic IRC clients** are not exposed (`IRCD_HOST=127.0.0.1`, no TCP proxy).
