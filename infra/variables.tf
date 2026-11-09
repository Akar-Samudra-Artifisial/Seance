variable "account_id" {
  description = "The only AWS account this configuration may change (provider allowed_account_ids)."
  type        = string
  default     = "255530395889"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "aws_profile" {
  description = "AWS CLI profile used by the provider."
  type        = string
  default     = "default"
}

variable "region" {
  description = "AWS region; the default VPC of this region is used."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.region))
    error_message = "region must look like us-east-1 (it is also rendered into user_data)."
  }
}

variable "instance_type" {
  description = "EC2 instance type (burstable, credit mode unlimited)."
  type        = string
  default     = "t3.medium"
}

variable "root_volume_gb" {
  description = "Size of the encrypted gp3 root volume in GiB."
  type        = number
  default     = 40
}

variable "workspaces_volume_gb" {
  description = "Size of the encrypted gp3 volume mounted at /srv/seance/workspaces (XFS, project quota)."
  type        = number
  default     = 20

  validation {
    condition     = var.workspaces_volume_gb >= 4
    error_message = "workspaces_volume_gb must be at least 4 GiB."
  }
}

variable "repo_url" {
  description = "Public HTTPS URL of the Séance repository that bootstrap.sh clones."
  type        = string
  default     = "https://github.com/Akar-Samudra-Artifisial/Seance.git"

  # The value is rendered into user_data (shell) and deploy.conf: a strict character set keeps it
  # from ever being anything but a URL.
  validation {
    condition     = can(regex("^https://[A-Za-z0-9._/-]+$", var.repo_url))
    error_message = "repo_url must match ^https://[A-Za-z0-9._/-]+$ (an https URL without credentials, query or spaces)."
  }
}

variable "git_ref" {
  description = "Pinned git ref (a full 40-character commit sha) that bootstrap.sh checks out. A branch name would make a reboot deploy whatever is newest."
  type        = string

  # Lower-case hex only: safe in shell, in git and in deploy.conf, and it pins one exact commit.
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.git_ref))
    error_message = "git_ref must be a full 40-character lower-case commit sha (git rev-parse HEAD)."
  }
}

variable "budget_email" {
  description = "E-mail address for the AWS Budgets alerts (no default: it must be set in terraform.tfvars)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "budget_email must be an e-mail address."
  }
}

variable "budget_limit_usd" {
  description = "Monthly cost budget for resources tagged Project=seance, in USD."
  type        = number
  default     = 40
}

variable "budget_actual_thresholds_usd" {
  description = "Actual-spend alert thresholds in USD."
  type        = list(number)
  default     = [20, 40]
}

variable "budget_forecast_threshold_usd" {
  description = "Forecasted-spend alert threshold in USD."
  type        = number
  default     = 40
}
