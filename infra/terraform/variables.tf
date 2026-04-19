variable "fleet_name" {
  description = "Name of the FleetMind fleet. Used to namespace all AWS resources and workspace paths."
  type        = string
  default     = "fleetmind"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type. t3.medium comfortably runs 3 OpenClaw agents. Scale up if adding more."
  type        = string
  default     = "t3.medium"
}

variable "agent_names" {
  description = "List of agent names. Each gets its own systemd service and workspace subdirectory."
  type        = list(string)
  default     = ["orchestrator", "pixel", "forge"]
}

variable "agent_ports" {
  description = "Map of agent name to OpenClaw port."
  type        = map(number)
  default = {
    orchestrator = 18789
    pixel        = 18790
    forge        = 18791
  }
}

variable "workspace_volume_size_gb" {
  description = "Size in GB of the EBS data volume shared by all agents (workspace, memory, state)."
  type        = number
  default     = 40
}

variable "openclaw_version" {
  description = "OpenClaw npm package version to install. Use 'latest' or pin to a specific version."
  type        = string
  default     = "latest"
}

variable "node_version" {
  description = "Node.js major version to install via nvm."
  type        = string
  default     = "22"
}

variable "rds_instance_class" {
  description = "RDS instance class for the shared Postgres database."
  type        = string
  default     = "db.t3.micro"
}

variable "rds_multi_az" {
  description = "Enable Multi-AZ for RDS. Set true for production."
  type        = bool
  default     = false
}

variable "rds_allocated_storage" {
  description = "Allocated storage in GB for RDS."
  type        = number
  default     = 20
}

variable "allowed_ssh_cidrs" {
  description = "CIDRs allowed to SSH to the fleet instance. Default empty — use SSM Session Manager instead."
  type        = list(string)
  default     = []
}

variable "ami_id" {
  description = "AMI ID override. Defaults to latest Amazon Linux 2023 if left empty."
  type        = string
  default     = ""
}
