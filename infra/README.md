# infra: the Séance judge server on AWS

Terraform for spec `deploy-aws`. The full runbook (prerequisites, SSM, spike, Kiro login, smoke test, updates, cost, teardown) is [docs/DEPLOY.md](../docs/DEPLOY.md).

- Terraform 1.9 or newer, provider `hashicorp/aws` `~> 6.0`, **local state** (git-ignored).
- Account `255530395889` only (`allowed_account_ids`), profile `default`, region `us-east-1`, the default VPC.
- `default_tags { Project = "seance" }` on every resource; `aws_ce_cost_allocation_tag` activates the tag for the budget.

## What it creates

| Resource | Notes |
| --- | --- |
| `aws_instance.seance` | `t3.medium`, `cpu_credits = "unlimited"`, Debian 13 from `data.aws_ami.debian13` (owner `136693071363`, release images `debian-13-amd64-20*`, never a hardcoded id), in a default subnet of a zone that offers the type (`aws_ec2_instance_type_offerings`), IMDSv2 required with hop limit 1, encrypted gp3 root 40 GB, no key pair. `ami` and `user_data` are in `ignore_changes`: updates go through `deploy/update.sh` |
| `aws_ebs_volume.workspaces` + `aws_volume_attachment.workspaces` | encrypted gp3 20 GB, attached as `/dev/sdf` with `stop_instance_before_detaching`; `bootstrap.sh` formats it XFS and mounts it at `/srv/seance/workspaces` with a hard project quota |
| `aws_eip.seance` + `aws_eip_association.seance` | allocated before the instance, so `user_data` can carry the hostname `<eip-with-dashes>.sslip.io` |
| `aws_security_group.seance` | ingress TCP 80 and 443 from anywhere; no 22 |
| `aws_iam_role.seance`, `aws_iam_instance_profile.seance` | `AmazonSSMManagedInstanceCore` only |
| `aws_budgets_budget.seance` | monthly cost budget on `user:Project$seance`, e-mail at 20 and 40 USD actual and 40 USD forecasted (`budget_email` has no default) |
| `aws_ce_cost_allocation_tag.project` | activates `Project`; may fail on the first apply until the tag appears in billing data (apply again a day later) |

`user_data.sh.tftpl` first installs and starts the SSM agent (official `.deb` from the regional AWS bucket), then installs git, clones the public repository (`repo_url`) at the pinned commit `git_ref` (a full sha, validated) into `/opt/seance`, verifies `HEAD`, and runs `deploy/bootstrap.sh` from that commit. User data holds no secrets.

## Use

```sh
cp terraform.tfvars.example terraform.tfvars   # git_ref, budget_email
terraform init
terraform plan -out seance.tfplan
terraform apply seance.tfplan
terraform output ssm_session_command
```

Outputs: `instance_id`, `public_ip`, `hostname`, `url`, `ssm_session_command` (`aws ssm start-session --target <id> --profile default --region us-east-1`), `ami`.

Teardown: see "Teardown" in [docs/DEPLOY.md](../docs/DEPLOY.md) (Kiro logout first), then `terraform destroy`.

## CI

The `infra` job in `.github/workflows/ci.yml` runs `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` here with no AWS credentials, and `shellcheck` on `deploy/*.sh`. It never plans or applies.
