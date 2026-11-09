# Requirements Document: deploy-aws

## Introduction

Put Séance on the internet for the Kiroween 2026 judges: one EC2 instance in AWS account `255530395889` (`us-east-1`, default VPC), described by Terraform with local state, reached only over HTTPS through Caddy and over AWS SSM Session Manager, with the agents in the rootless Podman sandbox of spec `agent-sandbox` and every protection of spec `public-hardening` switched on. The spec writes files only; every command that creates or reads cloud resources is an operator step in `docs/DEPLOY.md`.

## Glossary

- **Operator**: the developer who runs Terraform and the SSM steps.
- **Instance**: the EC2 server. **Workspaces_Volume**: the extra EBS volume at `/srv/seance/workspaces`.
- **Hostname**: `<elastic-ip-with-dashes>.sslip.io`, which resolves to the Elastic IP.
- **Kiro_Login**: the token directory written by `kiro-cli login --use-device-flow` for the `seance` user.
- **Spike_S12**: `deploy/spike-s12.sh`, agent-sandbox task 0.4 on the real host.

## Requirements

### Requirement 1: Infrastructure as code

**User Story:** As the Operator, I want the server described in Terraform, so that it can be created and destroyed in one command and nothing is clicked by hand.

#### Acceptance Criteria

1. `infra/` SHALL require Terraform `>= 1.9` and pin `hashicorp/aws` to `~> 6.0`, with local state and no backend block.
2. THE provider SHALL use profile `default`, region `us-east-1` and `allowed_account_ids = ["255530395889"]`, and SHALL set `default_tags { Project = "seance" }`.
3. THE configuration SHALL use the default VPC and a default subnet of it.
4. THE Instance SHALL be a `t3.medium` with `cpu_credits = "unlimited"`, created from the newest Debian 13 image found by a data source (owner `136693071363`, name `debian-13-amd64-*`); no AMI id SHALL be hardcoded.
5. THE root volume SHALL be gp3, 40 GB, encrypted. THE Workspaces_Volume SHALL be gp3, 20 GB, encrypted, in the Instance's availability zone, attached by a volume attachment.
6. AN Elastic IP SHALL be associated with the Instance, and the Hostname SHALL be a Terraform output.
7. Outputs SHALL include the instance id, the public IP, the Hostname and the command `aws ssm start-session --target <id> --profile default --region us-east-1`.
8. `aws_ce_cost_allocation_tag` SHALL activate the `Project` tag.
9. `infra/.gitignore` SHALL ignore `.terraform/`, `*.tfstate*`, `terraform.tfvars` and `crash.log`; only `terraform.tfvars.example` SHALL be committed.

### Requirement 2: Access and network security

#### Acceptance Criteria

1. THE Instance SHALL have no key pair, and the security group SHALL allow ingress on TCP 80 and 443 only.
2. Shell access SHALL be through SSM Session Manager, with an instance profile whose role has `AmazonSSMManagedInstanceCore` and nothing else.
3. IMDSv2 SHALL be required with a hop limit of 1.
4. Every EBS volume SHALL be encrypted.
5. THE ircd SHALL listen on `127.0.0.1` only (TCP 6667 and WebSocket 6680); the web server on `127.0.0.1:3000`.
6. Caddy SHALL obtain the TLS certificate for the Hostname automatically, proxy `/` to `127.0.0.1:3000` and `/ws` to `127.0.0.1:6680`, and SHALL overwrite `X-Forwarded-For` with the client address (`header_up X-Forwarded-For {remote_host}`), never append to it.

### Requirement 3: Cost control

#### Acceptance Criteria

1. AN AWS Budgets monthly cost budget SHALL filter on the tag `Project=seance` and e-mail at 20 USD and 40 USD actual spend and at 40 USD forecasted spend.
2. THE e-mail address SHALL be a variable without a default.
3. `docs/DEPLOY.md` SHALL state the expected monthly cost (about 39 USD: `t3.medium` 30.37, gp3 60 GB 4.80, public IPv4 3.65) and the `t3` unlimited CPU surcharge risk.

### Requirement 4: Server provisioning

#### Acceptance Criteria

1. `user_data` SHALL clone the public repository at a pinned git ref (a full commit sha, a Terraform variable), verify `HEAD`, and run `deploy/bootstrap.sh` from that commit. It SHALL contain no secret.
2. `deploy/bootstrap.sh` SHALL be idempotent and use `set -euo pipefail`. It SHALL install the packages, Node 26 (checksum-verified) and pnpm 11.7 through corepack, rootless Podman 5 for the `seance` user (subuid/subgid, linger, delegated cgroup controllers), Caddy, git and kiro-cli for Linux.
3. IT SHALL format the Workspaces_Volume as XFS once, mount it at `/srv/seance/workspaces` with `prjquota`, and set a hard project quota below the volume size.
4. IT SHALL check out the pinned ref into `/opt/seance`, run `pnpm install --frozen-lockfile` and `pnpm build`, pull the pinned sandbox base images by digest and build the agent image, and pin `SEANCE_SANDBOX_IMAGE` by digest.
5. IT SHALL install the systemd units and the Caddyfile and enable the services. IT SHALL NOT start the ircd while the Kiro_Login is missing, no account exists or `SEANCE_INVITERS` is unset; it SHALL print the next step instead.
6. `seance-ircd` and `seance-web` SHALL run as the `seance` user, restart on failure, and use `ProtectSystem=strict` with the needed `ReadWritePaths` and `PrivateTmp`. `NoNewPrivileges` SHALL be set where it does not break rootless Podman (see design D4).
7. `deploy/seance.env.example` SHALL list every variable the ircd, the runner and the web client need, including `IRCD_TRUSTED_PROXIES=127.0.0.1,::1` and the `https://<Hostname>` WebSocket origin.
8. `deploy/update.sh` SHALL deploy another commit (fetch, install, build, restart) and roll back to the previous commit when the health check fails.

### Requirement 5: Kiro authentication

#### Acceptance Criteria

1. `KIRO_API_KEY` SHALL NOT be used. THE Operator SHALL log in once over SSM as `seance` with `kiro-cli login --use-device-flow`, using the personal Kiro account that holds the Kiroween credits.
2. THE token directory SHALL become `SEANCE_SANDBOX_AUTH_DIR`, owned by `seance` with mode 0700.
3. `docs/DEPLOY.md` SHALL document the login exactly, and the teardown SHALL include `kiro-cli logout` and removal of the token directory.
4. THE credit caps of public-hardening SHALL stay on with conservative defaults for a public demo on a 4,000-credit budget, documented with their reasons.
5. WHEN agents are enabled, a systemd timer (`seance-kiro-refresh.timer`: 2 minutes after boot, then 20 minutes after each run ended, `OnUnitInactiveSec`) SHALL run `/usr/local/sbin/seance-kiro-refresh` (from `deploy/seance-kiro-refresh.sh`, installed by `bootstrap.sh` and reinstalled and enabled by `update.sh`) as the `seance` user, never as root, in a hardened unit. THE script SHALL hold a lock, refuse while the live write-ahead log is non-empty before any network call, copy the database with the SQLite backup API, force a token refresh on the copy, SHALL replace the live `data.sqlite3` atomically only when the copy's `expires_at` moved forward and the live `expires_at` is still the value read at the start, and SHALL otherwise leave the login untouched and exit 1 with `refresh FAILED, login kept (expires <old>)`. It SHALL print no token values. The teardown SHALL disable the timer before `kiro-cli logout`.

### Requirement 6: Spike S12 and checks

#### Acceptance Criteria

1. `deploy/spike-s12.sh` SHALL check rootless Podman 5, the pinned base images, that `apps/ircd/test/runner/sandbox.integration.test.ts` passes with no test skipped, and that writes past an XFS project quota fail. It SHALL print a pass/fail table and exit non-zero on any failure.
2. CI SHALL run `shellcheck` on `deploy/*.sh`, and `terraform fmt -check`, `terraform init -backend=false` and `terraform validate` in `infra/`, with no AWS credentials.

### Requirement 7: Runbook and order

#### Acceptance Criteria

1. `docs/DEPLOY.md` SHALL be the runbook: prerequisites, Terraform, SSM session, spike, Kiro login, smoke test, update, cost, teardown.
2. THE task order SHALL be: Spike_S12, full deploy, Kiro login, smoke test from a browser (wss connect, invite an agent, get a reply, exorcise), budget alert check, teardown.
3. Agent-sandbox task 0.4 SHALL be marked as waiting on the spike.
4. No command in this spec's implementation SHALL create or read cloud resources; `terraform apply`, a `terraform plan` with real credentials and the `aws` CLI are Operator steps only.
