output "instance_id" {
  description = "EC2 instance id."
  value       = aws_instance.seance.id
}

output "public_ip" {
  description = "Elastic IP of the server."
  value       = aws_eip.seance.public_ip
}

output "hostname" {
  description = "Public hostname (sslip.io resolves it to the Elastic IP); Caddy gets its TLS certificate for it."
  value       = local.hostname
}

output "url" {
  description = "Web client URL."
  value       = "https://${local.hostname}/"
}

output "ssm_session_command" {
  description = "Shell on the instance through SSM Session Manager (needs the session-manager-plugin)."
  value       = "aws ssm start-session --target ${aws_instance.seance.id} --profile ${var.aws_profile} --region ${var.region}"
}

output "ami" {
  description = "Debian 13 image the instance was created from."
  value       = "${data.aws_ami.debian13.name} (${data.aws_ami.debian13.id})"
}
