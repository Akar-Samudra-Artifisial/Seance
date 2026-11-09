# Séance public judge server (spec deploy-aws): one EC2 instance in the default VPC, reached only
# through Caddy on 80/443 and through SSM Session Manager. No SSH, no key pair.

# ---- lookups ---------------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

# Availability zones that offer the instance type (not every us-east-1 zone has every type).
data "aws_ec2_instance_type_offerings" "instance_type" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

# Default subnets of the default VPC, only in those zones.
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.instance_type.locations
  }
}

# Debian 13 (trixie), official images by the Debian cloud team. Its main repository ships rootless
# Podman 5 (Ubuntu 24.04 only has 4.9). Looked up, never hardcoded.
data "aws_ami" "debian13" {
  most_recent = true
  owners      = ["136693071363"]

  # Release images only (debian-13-amd64-20YYMMDD-NNNN); daily builds are named
  # debian-13-amd64-daily-* and are excluded.
  filter {
    name   = "name"
    values = ["debian-13-amd64-20*"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

locals {
  subnet_id = sort(data.aws_subnets.default.ids)[0]
  hostname  = "${replace(aws_eip.seance.public_ip, ".", "-")}.sslip.io"
}

# ---- network ---------------------------------------------------------------------------------

resource "aws_security_group" "seance" {
  name        = "seance-web"
  description = "Seance: HTTP and HTTPS to Caddy only (no SSH; SSM Session Manager instead)"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = "seance-web"
  }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.seance.id
  description       = "HTTP for the ACME challenge and the redirect to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.seance.id
  description       = "HTTPS (web client and the IRC WebSocket at /ws)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# Outbound: packages, the git clone, Kiro and the package registries. The agents' own egress is
# narrowed on the host by sandbox/seance-sandbox.nft (bootstrap.sh loads it).
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.seance.id
  description       = "All outbound IPv4"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Allocated before the instance, so user_data can carry the public hostname without a cycle.
resource "aws_eip" "seance" {
  domain = "vpc"

  tags = {
    Name = "seance"
  }
}

resource "aws_eip_association" "seance" {
  allocation_id = aws_eip.seance.id
  instance_id   = aws_instance.seance.id
}

# ---- IAM: SSM only ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "seance" {
  name               = "seance-instance"
  description        = "Seance instance: SSM Session Manager only"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.seance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "seance" {
  name = "seance-instance"
  role = aws_iam_role.seance.name
}

# ---- instance and storage --------------------------------------------------------------------

resource "aws_instance" "seance" {
  ami                    = data.aws_ami.debian13.id
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.seance.id]
  iam_instance_profile   = aws_iam_instance_profile.seance.name

  # No key pair and no port 22: shell access is `aws ssm start-session` only.
  associate_public_ip_address = true

  credit_specification {
    cpu_credits = "unlimited"
  }

  # IMDSv2 only, with a hop limit of 1. This is defence in depth, not the container barrier: rootless
  # pasta opens the containers' connections on the host as the seance user, so the hop limit does
  # not apply to them. What keeps the agents away from IMDS is the host rule
  # sandbox/seance-sandbox.nft, which drops 169.254.0.0/16 for the seance user (and the role only
  # grants SSM anyway).
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
    tags = {
      Name    = "seance-root"
      Project = "seance"
    }
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    repo_url             = var.repo_url
    git_ref              = var.git_ref
    public_hostname      = local.hostname
    workspaces_volume_id = aws_ebs_volume.workspaces.id
    vpc_cidr             = data.aws_vpc.default.cidr_block
    region               = var.region
  })

  tags = {
    Name = "seance"
  }

  lifecycle {
    # A newer Debian image or a new git_ref must not replace the running server: updates go
    # through deploy/update.sh over SSM.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_ebs_volume" "workspaces" {
  availability_zone = data.aws_subnet.chosen.availability_zone
  type              = "gp3"
  size              = var.workspaces_volume_gb
  encrypted         = true

  tags = {
    Name = "seance-workspaces"
  }
}

data "aws_subnet" "chosen" {
  id = local.subnet_id
}

resource "aws_volume_attachment" "workspaces" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.workspaces.id
  instance_id = aws_instance.seance.id

  # Detaching a mounted XFS volume from a running instance risks the filesystem: stop the
  # instance first (destroy or a volume replacement).
  stop_instance_before_detaching = true
}

# ---- cost --------------------------------------------------------------------------------------

# Activates the Project tag for cost allocation, so the budget below can filter on it. AWS accepts
# a key only after it has appeared in billing data (up to 24 hours after the first tagged
# resource); if apply fails here on the first run, apply again the next day.
resource "aws_ce_cost_allocation_tag" "project" {
  tag_key = "Project"
  status  = "Active"
}

resource "aws_budgets_budget" "seance" {
  name         = "seance-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$seance"]
  }

  dynamic "notification" {
    for_each = toset(var.budget_actual_thresholds_usd)
    content {
      notification_type          = "ACTUAL"
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "ABSOLUTE_VALUE"
      subscriber_email_addresses = [var.budget_email]
    }
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.budget_forecast_threshold_usd
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_email]
  }

  depends_on = [aws_ce_cost_allocation_tag.project]
}
