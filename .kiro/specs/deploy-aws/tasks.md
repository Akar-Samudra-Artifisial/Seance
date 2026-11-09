# Implementation Plan: deploy-aws

## Overview

File-writing tasks first (Terraform, host files, CI, runbook), then the operator steps in the order of Requirement 7.2. No task in this plan runs `terraform apply`, a `terraform plan` against real credentials, the `aws` CLI or anything else that creates or reads cloud resources while it is implemented; tasks 1 to 6 are carried out by the Operator following `docs/DEPLOY.md`.

## Tasks

- [x] 0. Files
  - [x] 0.1 `infra/`: `versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`, `user_data.sh.tftpl`, `terraform.tfvars.example`, `.gitignore`, `README.md`
    - _Requirements: 1.1 to 1.9, 2.1 to 2.4, 3.1, 3.2, 4.1_
  - [x] 0.2 `deploy/`: `bootstrap.sh`, `update.sh`, `spike-s12.sh`, `seance.env.example`, `Caddyfile`, `systemd/` units
    - _Requirements: 2.5, 2.6, 4.2 to 4.8, 5.2, 5.4, 6.1_
  - [x] 0.3 CI job `infra`: shellcheck, `terraform fmt -check`, `init -backend=false`, `validate`, no AWS credentials
    - _Requirements: 6.2_
  - [x] 0.4 `docs/DEPLOY.md` runbook; agent-sandbox task 0.4 marked as waiting on the spike; README and usage log
    - _Requirements: 3.3, 5.3, 7.1, 7.3_
  - [x] 0.5 Local checks: `shellcheck` and `terraform fmt`/`init -backend=false`/`validate` without credentials; `pnpm build`, `typecheck`, `lint`, `test`, `test:e2e`
    - _Requirements: 6.2, 7.4_

  - [x] 0.6 Review fixes: web.env before the build; install and build as `seance`; pinned Kiro installer (`deploy/pins.env`); fixture image built before the egress rule in the spike; SSM agent first in `user_data`; ircd unit exceptions and the `user@<uid>` drop-in; AMI release filter, zone offerings, `stop_instance_before_detaching`, IMDS comment; caddy log dir, apt lock timeout, Podman recommends, `unattended-upgrades`, `kiro-cli whoami` gate; strict `repo_url`/`git_ref`/`region` validation and quoted `deploy.conf`; HSTS, `nosniff`, `no-referrer`
    - _Requirements: 2.3, 2.6, 4.1 to 4.6, 5.1, 6.1_

- [x] 1. **Operator:** Spike S12 on the instance
  - `terraform apply` (DEPLOY.md step 1), SSM session (step 2), wait for the bootstrap, then `sudo /opt/seance/deploy/spike-s12.sh`
  - All rows PASS; copy `/var/lib/seance/s12/summary.txt` and `s12.log` into `spikes/acp/FINDINGS.md` section S12; tick agent-sandbox task 0.4
  - _Requirements: 6.1, 7.3_

- [x] 2. **Operator:** Full deploy
  - Accounts and `SEANCE_INVITERS` (DEPLOY.md step 4); `https://<hostname>/` serves the web client with a valid certificate; `systemctl status seance-web caddy` active; `/etc/seance/seance.env` reviewed (caps, CIDRs, image digest)
  - _Requirements: 2.5, 2.6, 4.2 to 4.7_

- [x] 3. **Operator:** Kiro login
  - DEPLOY.md step 5: `kiro-cli login --use-device-flow` as `seance` with the personal Kiro account, mode 0700, `bootstrap.sh` again; `seance-ircd` and `seance-sandbox-nft` active; optional `spike-s12.sh --with-auth`
  - _Requirements: 5.1, 5.2_

- [x] 4. **Operator:** Smoke test from a browser
  - DEPLOY.md step 6: wss connect with an account, `/invite coder`, a reply after `+v`, `/whois` budget line, `/kick` exorcises and leaves no container; a forged `X-Forwarded-For` is ignored
  - _Requirements: 2.6, 5.4_
  - Done 2026-11-09 by script over wss (commit 471e2a4): login, invite, `PONG` reply after `+v`, kick exorcises (`0.01 credits used`, `podman ps -a` empty), forged `X-Forwarded-For: 6.6.6.6` ignored (WHOIS shows the real client address), web client 200 with a valid certificate. Open: the same flow in a browser and the `/whois` budget line (not seen in WHOIS of an idle agent)
  - Done 2026-11-10 in a browser (commit cf9e727, account `bayu`): `/join #demo4`, `/invite coder`, `worktree ready`, `+v`, `<+coder> PONG`, `/whois coder` shows `budget: today 0.19 / 100.00 (UTC)` and `credits: #demo4 0.02 / total 0.19`, `/kick coder` exorcises (`0 files reverted · 0.02 credits used`, `0 agents`). The connect dialog needs `bayu:<secret>` in the password field; `/kick #demo4 coder` is not supported (`/kick <nick>` in the channel window)

- [ ] 5. **Operator:** Budget alert check
  - In the AWS Budgets console: `seance-monthly` exists with the three notifications for `budget_email`; Cost Explorer shows the `Project` tag as active (re-apply after a day if `aws_ce_cost_allocation_tag` failed); after a few days the actual cost matches the estimate in DEPLOY.md step 8
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 6. **Operator:** Teardown after judging
  - DEPLOY.md step 9: stop the ircd and the egress rule, `kiro-cli logout` as `seance`, remove `/home/seance/.local/share/kiro-cli`, `terraform destroy`, delete the local state
  - _Requirements: 5.3_

- [x] 7. Kiro login refresh (criterion 5.5)
  - [x] 7.1 `deploy/seance-kiro-refresh.sh` (POSIX sh, shellcheck clean): forced refresh on a copy, atomic install only when `expires_at` moved forward and the live WAL is empty, no secrets in output
    - _Requirements: 5.5_
  - [x] 7.2 `deploy/systemd/seance-kiro-refresh.{service,timer}`; `bootstrap.sh` installs the script (root-owned, 0755) and enables the timer with the agents; `update.sh` reinstalls both
    - _Requirements: 5.5_
  - [x] 7.3 `docs/DEPLOY.md` steps 5 and 9, `docs/SANDBOX.md` (why a copy, Kiro#4847 and #9783, egress), `docs/KIRO_USAGE.md`; tests in `apps/runner/test/sandbox-files.test.ts`; CI `infra` already runs `shellcheck deploy/*.sh`
    - _Requirements: 5.3, 5.5, 6.2_

  - [x] 7.4 Review fixes: run as `seance` (no root, no `runuser`/`chown`), `flock`, WAL check before the network, SQLite backup API, abort when the live login changed, timer on `OnUnitInactiveSec`, unit hardening, `update.sh` enables the timer, DEPLOY.md re-login stops and starts the timer; tests in `sandbox-files.test.ts`
    - _Requirements: 5.5_

  - [x] 7.5 Small fixes: delete leftover `.data.sqlite3.*` staged files after taking the lock; `sync` the staged file before the rename; open the live database read-only (`mode=ro`) where it is only read; `bootstrap.sh` fixes the auth dir ownership with `chown -hR`; task 7.2 text says 0755; tests in `sandbox-files.test.ts`
    - _Requirements: 5.5_

- [x] 8. Repeatable smoke test (`tools/smoke-wss.mjs`)
  - [x] 8.1 `tools/smoke-wss.mjs`: wss login with `SMOKE_SECRET`, fresh channel, invite, wait for BOTH `worktree ready` and the agent's JOIN before the prompt, `+v`, one word, KICK on the first reply, finish on the credits line; kicks the agent on any failure after the invite; exit 0/1/2
    - _Requirements: 7.2, 7.5_
  - [x] 8.2 `docs/DEPLOY.md` step 6 (command, what success looks like, about 0.02 credits), tests in `apps/runner/test/sandbox-files.test.ts`, `docs/KIRO_USAGE.md`
    - _Requirements: 7.2, 7.5_

  - [x] 8.3 Review fixes: the reply counts only after the prompt was delivered (no kick-then-prompt race); SIGINT/SIGTERM and socket errors go through the same fail path, which kicks whenever the invite was sent and waits up to 500 ms for the flush; server text is stripped of colour and control characters, cut to 200 characters and has the secret redacted; `SMOKE_SECRET` with CR, LF, NUL or a space exits 2; fail fast on JOIN (403, 405, 471, 473, 474, 475, 477) and INVITE (401, 443, 482) errors; example host in the header; DEPLOY.md notes the `ws` fallback needs `pnpm install`; tests in `sandbox-files.test.ts`
    - _Requirements: 7.2, 7.5_

## Notes

- `infra/.terraform.lock.hcl` is committed so CI and the Operator use the same provider build.
- The instance is never replaced by an update (`ignore_changes = [ami, user_data]`); use `deploy/update.sh <sha>`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1", "0.2"] },
    { "id": 1, "tasks": ["0.3", "0.4"] },
    { "id": 2, "tasks": ["0.5"] },
    { "id": 3, "tasks": ["1"] },
    { "id": 4, "tasks": ["2"] },
    { "id": 5, "tasks": ["3"] },
    { "id": 6, "tasks": ["4"] },
    { "id": 7, "tasks": ["5"] },
    { "id": 8, "tasks": ["6"] },
    { "id": 9, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 10, "tasks": ["7.4"] },
    { "id": 11, "tasks": ["7.5"] },
    { "id": 12, "tasks": ["8.1", "8.2"] },
    { "id": 13, "tasks": ["8.3"] }
  ]
}
```
