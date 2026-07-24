variable "fleet_name" {
  description = "Example FleetMind fleet name."
  type        = string
  default     = "fleetmind-example"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-west-2"
}
