variable "fleet_name" {
  description = "Example FleetMind fleet name."
  type        = string
  default     = "fleetmind-existing-vpc"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-west-2"
}

variable "vpc_id" {
  description = "Existing VPC ID."
  type        = string
}

variable "existing_private_subnet_ids" {
  description = "Existing private subnet IDs for FleetMind agents."
  type        = list(string)
}
