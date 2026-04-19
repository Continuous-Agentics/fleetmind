variable "fleet_name" {
  description = "Name of the FleetMind fleet. Used to namespace all AWS resources."
  type        = string
  default     = "fleetmind"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type for each agent. t3.small is a good starting point."
  type        = string
  default     = "t3.small"
}

variable "agent_names" {
  description = "List of agent names. Each gets its own EC2 instance and EBS volume."
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
  description = "Size in GB of the EBS data volume for each agent's workspace (memory, state)."
  type        = number
  default     = 20
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
  description = "CIDRs allowed to SSH to agent instances. Default empty — use SSM instead."
  type        = list(string)
  default     = []
}

variable "openclaw_image" {
  description = "Docker image to run for each OpenClaw agent."
  type        = string
  default     = "openclaw/openclaw:latest"
}

variable "ami_id" {
  description = "AMI ID to use for agent instances. Defaults to latest Amazon Linux 2023 (fetched via data source if left empty)."
  type        = string
  default     = ""
}
