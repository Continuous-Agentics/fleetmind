config {
  format             = "compact"
  call_module_type   = "all"
  force              = false
  disabled_by_default = false
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.48.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# Keep provider requirements explicit in the root module and submodules so
# registry consumers and recursive CI runs don't depend on implicit provider
# resolution.
rule "terraform_required_providers" {
  enabled = true
}

rule "terraform_required_version" {
  enabled = true
}

# Reusable module: some declared variables (e.g. existing_public_subnet_ids)
# are intentionally accepted-but-unused today for interface parity with the
# created-VPC path. Left enabled; inline `tflint-ignore` comments cover the
# known exceptions instead of disabling this rule repo-wide.
rule "terraform_unused_declarations" {
  enabled = true
}

rule "terraform_naming_convention" {
  enabled = true
  format  = "snake_case"
}
