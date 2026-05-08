###############################################################################
# VPC — create new or adopt existing
#
# Set var.vpc_id to deploy into an existing VPC.
# Leave it empty (default) to create a fresh VPC.
#
# When using an existing VPC:
#   - Set vpc_id to your existing VPC ID
#   - Set existing_public_subnet_ids (2 required — for EC2 + NAT GW)
#   - Set existing_private_subnet_ids (2 required — for RDS)
#   - No new VPC, subnets, IGW, NAT GW, or route tables are created
###############################################################################

locals {
  create_vpc = var.vpc_id == ""

  azs = local.create_vpc ? slice(data.aws_availability_zones.available.names, 0, 2) : []

  vpc_id          = local.create_vpc ? aws_vpc.main[0].id : var.vpc_id
  public_subnets  = local.create_vpc ? aws_subnet.public[*].id : var.existing_public_subnet_ids
  private_subnets = local.create_vpc ? aws_subnet.private[*].id : var.existing_private_subnet_ids
}

data "aws_availability_zones" "available" {
  state = "available"
}

# ── New VPC (only created when vpc_id is not provided) ────────────────────────

resource "aws_vpc" "main" {
  count = local.create_vpc ? 1 : 0

  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.fleet_name}-vpc" }
}

resource "aws_subnet" "public" {
  count = local.create_vpc ? 2 : 0

  vpc_id            = aws_vpc.main[0].id
  cidr_block        = cidrsubnet("10.0.0.0/16", 8, count.index)
  availability_zone = local.azs[count.index]

  map_public_ip_on_launch = true
  tags                    = { Name = "${var.fleet_name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count = local.create_vpc ? 2 : 0

  vpc_id            = aws_vpc.main[0].id
  cidr_block        = cidrsubnet("10.0.0.0/16", 8, count.index + 10)
  availability_zone = local.azs[count.index]

  tags = { Name = "${var.fleet_name}-private-${count.index}" }
}

resource "aws_internet_gateway" "main" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.main[0].id
  tags   = { Name = "${var.fleet_name}-igw" }
}

resource "aws_route_table" "public" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.main[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main[0].id
  }

  tags = { Name = "${var.fleet_name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count = local.create_vpc ? 2 : 0

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_eip" "nat" {
  count  = local.create_vpc ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.fleet_name}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  count = local.create_vpc ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.fleet_name}-nat" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.main[0].id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[0].id
  }

  tags = { Name = "${var.fleet_name}-private-rt" }
}

resource "aws_route_table_association" "private" {
  count = local.create_vpc ? 2 : 0

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}
