# Mirrors the defaults declared in ../variables.tf.

# Fleet
fleet_name    = "fleetmindv2"
aws_region    = "us-west-2"
instance_type = "t3.medium"

# Agents
agent_names = ["Blanket", "Charlie"]
agent_ports = {
  Blanket = 18789
  Charlie = 18790
}
openclaw_version  = "latest"
node_version      = "22"
fleetmind_version = "0.4.3"

# RDS
enable_rds            = false

# Networking
enable_interface_endpoints  = true

# Per-agent overrides
agent_instance_types = {}
agent_models         = {}
agent_orchestrators  = {}

# Delegation
delegation_enabled      = true
