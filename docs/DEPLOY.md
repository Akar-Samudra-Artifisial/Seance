# Deploying the public judge server (AWS)

The runbook for spec `deploy-aws`: one EC2 instance in the default VPC of `us-east-1`, account `255530395889`, Terraform in [`infra/`](../infra/), server files in [`deploy/`](../deploy/). Follow the steps in order. Nothing in the repository creates cloud resources by itself; every `terraform apply` is an operator decision.

| Item | Value |
| --- | --- |
| Instance | `t3.medium`, credit mode `unlimited`, Debian 13 (trixie) official image (owner `136693071363`, `debian-13-amd64-*`, looked up by Terraform) |
| Storage | root gp3 40 GB encrypted; gp3 20 GB encrypted at `/srv/seance/workspaces`, XFS with a hard project quota (`SEANCE_WORKSPACES`) |
| Network | Elastic IP; hostname `<eip-with-dashes>.sslip.io`; security group ingress 80 and 443 only |
| Access | AWS SSM Session Manager only: no port 22, no key pair; IMDSv2 required, hop limit 1 |
| TLS | Caddy, automatic HTTPS for the sslip.io name; `/` to Next on `127.0.0.1:3000`, `/ws` to the ircd on `127.0.0.1:6680` |
| Cost guard | AWS Budgets on tag `Project=seance`: e-mails at 20 and 40 USD actual, 40 USD forecast |

## 0. Prerequisites (laptop)

- Terraform 1.9 or newer, the AWS CLI v2 and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
- Credentials for profile `default` in account `255530395889`: `aws login --profile default` (or `aws sso login --profile default`, depending on how the profile is set up). Check with `aws sts get-caller-identity --profile default`.
- The commit to deploy is pushed to the public repository. Note its full sha: `git rev-parse HEAD`.

## 1. Terraform

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars    # git-ignored; set git_ref and budget_email
terraform init
terraform plan -out seance.tfplan
terraform apply seance.tfplan
terraform output
```

The outputs are `instance_id`, `public_ip`, `hostname`, `url` and `ssm_session_command`. State is local (`infra/terraform.tfstate`, git-ignored): keep the folder until the teardown.

On the very first apply, `aws_ce_cost_allocation_tag.project` can fail because AWS accepts a tag key only after it has appeared in billing data (up to 24 hours). Everything else is created; run `terraform apply` again the next day to activate the tag. Until then the budget filter on `Project=seance` matches nothing, so watch Cost Explorer by hand on day one.

cloud-init first installs and starts the SSM agent (the Debian image does not ship it; the official `amazon-ssm-agent.deb` comes from the regional AWS bucket), so Session Manager works even if the bootstrap fails. Then it clones the repository at `git_ref` into `/opt/seance` and runs `deploy/bootstrap.sh`. It takes about 10 to 15 minutes (packages, Node, the pnpm build, kiro-cli, the image builds). Its log is `/var/log/seance-bootstrap.log`.

## 2. SSM session

```sh
$(terraform -chdir=infra output -raw ssm_session_command)
# = aws ssm start-session --target <instance id> --profile default --region us-east-1
sudo tail -n 30 /var/log/seance-bootstrap.log
```

The bootstrap ends with "the ircd waits for the steps above": the web client and Caddy run, the ircd does not.

## 3. Spike S12 (first)

```sh
sudo /opt/seance/deploy/spike-s12.sh
```

It checks rootless Podman 5 with the cgroup controllers, the pinned base images, `apps/ircd/test/runner/sandbox.integration.test.ts` passing with nothing skipped, that writes past the XFS project quota fail, and the s12 flag spellings. It prints a pass/fail table, exits non-zero on any failure and leaves the logs in `/var/lib/seance/s12/`. The script loads the agents' egress rule (`seance-sandbox-nft.service`) before the integration suite, because the runner refuses to start when `1.1.1.1:443` is reachable.

Copy `/var/lib/seance/s12/summary.txt` and `s12.log` into [`spikes/acp/FINDINGS.md`](../spikes/acp/FINDINGS.md) section S12. Agent-sandbox task 0.4 is **waiting on this spike**; tick it when the table is all PASS (the `s12-auth` row runs after the Kiro login, step 5).

Do not continue to the Kiro login while a row fails: fix the host, then run the spike again.

## 4. Accounts and inviters

Judges log in with `PASS <nick>:<secret>`. In the web client's connect dialog they type only the secret in the password field: the client adds the nick, so `PASS <nick>:<secret>` goes out. Typing `nick:secret` there also works, and it is the form every other IRC client sends. The server password typed in the dialog gives a guest login too (the ircd accepts `<nick>:<server password>` as a guest). For each judge (secret on stdin, never on the command line):

```sh
node /opt/seance/tools/seance-account.mjs judge1 | sudo -u seance tee -a /etc/seance/accounts
sudo sed -i 's/^SEANCE_INVITERS=.*/SEANCE_INVITERS=judge1,judge2,operator/' /etc/seance/seance.env
```

Send each judge their nick and secret, and the URL, out of band. The guest password (chat only, no invites) is `IRCD_SERVER_PASSWORD` in `/etc/seance/seance.env`. Do not reuse the server password as an account secret: anyone who knows the server password could then log in as that account.

## 5. Kiro login

There is no `KIRO_API_KEY` on this host. The operator logs in once, as the `seance` user, with the **personal Kiro account that holds the Kiroween credits**. The token directory `/home/seance/.local/share/kiro-cli` becomes `SEANCE_SANDBOX_AUTH_DIR` (mounted read-only into each agent container).

The agents' egress rule lets the `seance` user reach only the agents' allow-list, so stop it for the login (no agent runs yet):

```sh
sudo systemctl stop seance-kiro-refresh.timer      # a re-login must not race a refresh
sudo systemctl stop seance-ircd.service seance-sandbox-nft.service
sudo -iu seance
kiro-cli login --use-device-flow
#   kiro-cli prints a URL and a code: open the URL on your laptop, enter the code, sign in with
#   the personal Kiro account and approve. Wait until kiro-cli reports that you are logged in.
kiro-cli whoami                         # must succeed: bootstrap.sh checks exactly this
chmod 0700 ~/.local/share/kiro-cli
exit
sudo /opt/seance/deploy/bootstrap.sh    # now loads the egress rule and starts the ircd
sudo /opt/seance/deploy/spike-s12.sh --with-auth   # optional: the s12-auth row (one prompt)
sudo systemctl start seance-kiro-refresh.timer
```

`bootstrap.sh` sets the directory to `seance`, mode 0700, and refuses to start the ircd while `kiro-cli whoami` fails as `seance`, while `/etc/seance/accounts` has no account, or while `SEANCE_INVITERS` still holds the placeholder. After the login, `seance-kiro-refresh.timer` keeps the token fresh: 20 minutes after each run it forces a refresh on a copy of the login and installs the copy only when the refresh worked (`deploy/seance-kiro-refresh.sh`, installed as `/usr/local/sbin/seance-kiro-refresh`, run by the unit as the `seance` user, not root; why on a copy is in [SANDBOX.md](./SANDBOX.md)). `bootstrap.sh` and `update.sh` enable the timer together with the agents. Check it with `journalctl -u seance-kiro-refresh` (a good run logs `refreshed, login expires ...`; a failed one logs `refresh FAILED, login kept`). If the host was off, or the timer stopped, for more than an hour, the token has expired for good: log in again (repeat this step, stopping the ircd first).

**Risk, stated plainly** ([SANDBOX.md](./SANDBOX.md)): the login is readable inside every agent container, and a prompt-injected `+o` agent can send it out. The credit caps below bound the spend; the Kiro account is logged out right after judging (step 9).

## 6. Smoke test from a browser

First the scripted check, from your laptop (Node 26, no install needed). It logs in over wss, joins a fresh `#smoke<digits>` channel, invites the agent, waits for both `worktree ready` and the agent's JOIN, gives it `+v`, asks for one word, kicks it on the first reply and waits for the ChanServ credits line:

```sh
SMOKE_SECRET="$(secret get <your-password-manager-entry>)" node tools/smoke-wss.mjs <hostname> judge1
#   [  1.2s] registered as judge1 ... [ 18.4s] reply: PONG (PONG) ... kick ok ... credits line: ... credits used
```

The script needs no install: Node 26's global `WebSocket` is used and sends the `Origin` header. Only if that is missing does it fall back to the `ws` package of `apps/ircd`, which needs the repository installed (`pnpm install`). Success is exit code 0 with a `reply: ... (PONG)` line, `kick ok` and the `credits used` line. A failure exits 1 with the reason (`could not start`, an `ERROR`, a closed socket, or the 120 s timeout, `SMOKE_TIMEOUT_S` changes it) and kicks the agent first, so no session is left running. `secret get` only stands for any way of filling `SMOKE_SECRET` from a password manager; the secret is read from that variable alone and never printed. A run costs about 0.02 Kiro credits. Then, in a browser:

1. Open `https://<hostname>/` (from `terraform output url`). The certificate is from Let's Encrypt.
2. Connect with an account (`judge1` / its secret). The status window shows the welcome and the MOTD; the browser's network tab shows `wss://<hostname>/ws` open.
3. `/join #smoke`, then `/invite coder`. ChanServ reports `worktree ready`, and `coder` joins.
4. `/mode #smoke +v coder`, then write `coder: say hello`. A reply arrives within a minute.
5. `/whois coder` shows `budget: today X / 100.00 (UTC)` and the credits used.
6. `/kick coder done`. The channel shows `*** coder has been exorcised`; `sudo -u seance podman ps -a` lists no container for it.
7. From the laptop, check that the forged header is ignored: connect once with `X-Forwarded-For: 203.0.113.1` (for example with `websocat -H 'X-Forwarded-For: 203.0.113.1' wss://<hostname>/ws`) and confirm with `/whois` that it shows your real address.

## 7. Updates

```sh
sudo /opt/seance/deploy/update.sh <40-character commit sha>
```

It fetches the commit as root and hands the tree to `seance`, stops the ircd and the egress rule (the build needs the npm registry and the font files of `next/font` as `seance`), runs `pnpm install --frozen-lockfile` and `pnpm build` as `seance` with `/etc/seance/web.env` loaded (so the client is built for `wss://<hostname>/ws`), restarts the services, checks `http://127.0.0.1:3000/` and (if the ircd was running) `http://127.0.0.1:6680/healthz`, and rolls back to the previous commit when anything fails. Agents are offline for the few minutes of the build.

### Pinned downloads

`deploy/pins.env` holds `KIRO_INSTALLER_SHA256`, the sha256 of the script at `https://cli.kiro.dev/install`. `bootstrap.sh` refuses to run an installer that is missing or does not match (the installer then checks the kiro-cli package against Kiro's release manifest itself). When Kiro publishes a new installer, bootstrap stops with a checksum error; read the new script, put its sha256 into `deploy/pins.env` (the file says how), commit, and deploy that commit. Node is checked against the `SHASUMS256.txt` of its release, the sandbox base images are pulled by digest. The agent image is rebuilt when anything under `sandbox/` or the kiro-cli binary changes: `bootstrap.sh` labels the image `io.seance.context-sha` with a sha256 over the sorted `sandbox/` files plus the kiro-cli sha, logs "agent image rebuilt: sandbox context changed" on a mismatch, and restarts `seance-ircd` if it is running. Manual check: `sudo -u seance podman image inspect --format '{{index .Labels "io.seance.context-sha"}}' "$(sed -n 's/^SEANCE_SANDBOX_IMAGE=//p' /etc/seance/seance.env)"`, then change a file under `sandbox/`, run `bootstrap.sh` and confirm the log line, a new digest in the env file and the ircd restart (`apps/runner/test/sandbox-files.test.ts` pins the script text). A new `git_ref` in `terraform.tfvars` does not touch the running instance (`ignore_changes`); it only matters for a rebuilt instance.

## 8. Cost

About **39 USD per month**, running 24/7 in `us-east-1`:

| Item | Monthly |
| --- | --- |
| `t3.medium` on demand (0.0416 USD/h × 730 h) | 30.37 USD |
| gp3, 60 GB (0.08 USD/GB) | 4.80 USD |
| Public IPv4 address (0.005 USD/h × 730 h) | 3.65 USD |
| **Total** | **≈ 38.82 USD** |

**t3 unlimited risk:** above the baseline (20 % per vCPU for `t3.medium`) the instance spends CPU credits, and once they run out each surplus vCPU-hour costs 0.05 USD. Full load on both vCPUs for a whole month would add about 58 USD. The 20/40 USD budget e-mails are the guard; check `CPUSurplusCreditsCharged` in CloudWatch if a mail arrives early. Data transfer out beyond the free tier is not included.

### Credit caps (Kiro)

The Kiroween budget is 4,000 credits. `deploy/seance.env.example` sets:

| Variable | Value | Why |
| --- | --- | --- |
| `SEANCE_DAILY_CREDIT_CAP` | `100` | All agents and private sessions together per UTC day; 30 days are at most 3,000, leaving 1,000 for the spike, smoke tests and mistakes |
| `SEANCE_CHANNEL_CREDIT_CAP` | `30` | A channel is blocked at 30 credits until an authenticated inviter with `+o` sends `!reset-credits` |
| `SEANCE_MAX_AGENT_CHANNELS` | `2` | Channels with agents at once |
| `SEANCE_MAX_CONTAINERS` | `3` | Agent sessions at once (memory: 3 × 768 MiB on 4 GiB) |
| `SEANCE_IDLE_TIMEOUT_S` | `900` | Seconds without activity before an abandoned agent is released and its container removed (60 to 86400) |
| `SEANCE_INVITE_RATE` | `3` | Invites per inviter and minute |
| `SEANCE_INVITERS` | the judges' account nicks | Only logged-in accounts on the list summon agents |

There is no per-account credit counter in public-hardening: spend is bounded per channel and per day for everyone together, and only listed accounts can start agents. Pause everything at once with `sudo -u seance touch /srv/seance/workspaces/.seance-paused` (remove it to resume).

## 9. Teardown

```sh
# on the instance (SSM)
sudo systemctl stop seance-ircd.service seance-sandbox-nft.service
sudo systemctl disable --now seance-kiro-refresh.timer   # first: it would otherwise refresh a login you are removing
sudo -iu seance kiro-cli logout
sudo rm -rf /home/seance/.local/share/kiro-cli
exit
# on the laptop
cd infra && terraform destroy
```

Then check the Kiro account's active sessions in the Kiro web console and sign the device-flow session out if it is still listed. `terraform destroy` removes the instance, both volumes, the Elastic IP, the security group, the IAM role and profile, and the budget. It does not deactivate the cost allocation tag (harmless) and leaves `infra/terraform.tfstate` empty; delete the file.

## Reference

### Caddy overwrites `X-Forwarded-For`

The ircd trusts `X-Forwarded-For` only from `IRCD_TRUSTED_PROXIES=127.0.0.1,::1` and takes the right-most address that is not a trusted proxy. That is the real client only because Caddy **replaces** the header (`header_up X-Forwarded-For {remote_host}` in [`deploy/Caddyfile`](../deploy/Caddyfile)) instead of appending to the client's value, and because Caddy has no `trusted_proxies` of its own. Otherwise a client could spread its connections over invented addresses and walk past the per-IP limits.

### Disk quota

`/srv/seance/workspaces` is its own XFS volume with a hard project quota 2 GiB below its size (`bootstrap.sh`), and `spike-s12.sh` proves that writes past a quota fail. The runner's `SEANCE_WORKTREE_MAX_BYTES` check (after every tool call and before each host commit) only stops a turn early; the quota is what stops the disk from filling. Not covered: `$HOME` and `/tmp` inside a container (tmpfs, counted against its memory) and the repository object store at `/srv/seance/target` on the root volume.

### Classic clients

`IRCD_HOST=127.0.0.1` keeps TCP 6667 off the internet; only the web client (through Caddy) is public. A TLS TCP proxy for irssi or HexChat is not part of this deployment.

### Files on the instance

| Path | Owner, mode | Content |
| --- | --- | --- |
| `/opt/seance` | seance | the repository at the deployed commit, built by `seance` (git runs as root with `safe.directory`) |
| `/etc/seance/seance.env` | root, 0600 | ircd and runner environment (server password) |
| `/etc/seance/web.env` | root, 0644 | `NEXT_PUBLIC_IRCD_WS_URL` |
| `/etc/seance/accounts` | seance, 0600 | judge accounts (scrypt hashes) |
| `/etc/seance/deploy.conf` | root, 0600 | repository URL, commit, hostname, volume id, VPC CIDR |
| `/home/seance/.local/share/kiro-cli` | seance, 0700 | the Kiro login (`SEANCE_SANDBOX_AUTH_DIR`) |
| `/usr/local/sbin/seance-kiro-refresh` | root, 0755 | the login refresh script, run as `seance` by `seance-kiro-refresh.timer` (20 minutes after each run) |
| `/srv/seance/workspaces` | seance | channel worktrees, `.seance-credits.json`, `.seance-paused` |
| `/srv/seance/target` | seance | the demo target repository |
| `/etc/nftables.d/seance-sandbox.nft` | root | the agents' egress rule |
| `/etc/systemd/system/seance-ircd.service.d/user-manager.conf` | root | `After=`/`Wants=user@<uid>.service`, rendered by `bootstrap.sh` |

### Hardening notes

- `seance-ircd` runs with `NoNewPrivileges=no` and without `ProtectKernelTunables`/`ProtectControlGroups` on purpose: rootless Podman needs the setuid `newuidmap`/`newgidmap`, writes `/proc/sys` entries for its containers and manages cgroups through the user manager. The agent containers run with all capabilities dropped and `no-new-privileges`. `seance-web` keeps the full set.
- Security updates install daily (`unattended-upgrades`, Debian's security origin).
- Caddy adds `Strict-Transport-Security` (no `includeSubDomains`: other sslip.io names are not ours), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; the Content-Security-Policy is the app's own (a nonce per request).
- IMDS: the hop limit of 1 does not stop the containers, because pasta opens their connections on the host. The host rule drops `169.254.0.0/16` for the `seance` user, and the instance role allows SSM only.
