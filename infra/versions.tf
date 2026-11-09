terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Local state on purpose (one operator, one instance for the judging period). The state files are
  # git-ignored in infra/.gitignore.
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  # Refuse to touch any other account, whatever the profile points at.
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project = "seance"
    }
  }
}
