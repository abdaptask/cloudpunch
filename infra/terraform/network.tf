# =====================================================================
# Network (ADR-0035 §3 as revised by ADR-0045)
# =====================================================================
#
# Two AZs. Public subnets hold the API tasks; private subnets hold the
# database, with no route to the internet at all.
#
# ADR-0045: the tasks reach Cloudflare outbound (cloudflared), so
# nothing on the internet connects in. The tasks' security group has
# NO inbound rules; they get a public IP only to make outbound calls
# (Cloudflare, Microsoft sign-in keys, Graph, DB-IP). That replaces the
# load balancer and the NAT gateway (~$55/month) without opening a port.
# =====================================================================

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "cloudpunch-${var.env}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  tags              = { Name = "${local.name}-private-${local.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private subnets: the VPC's local route only (the default route table).

# ---------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "API and job tasks: no inbound; outbound to Cloudflare, Microsoft, AWS APIs"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-api" }
  # No inline rules: every rule is its own resource below (mixing the two
  # makes Terraform remove one or the other).
}

locals {
  api_egress_internet = {
    https       = { port = 443, protocol = "tcp", note = "HTTPS: Cloudflare, Entra, Graph, AWS APIs, DB-IP" }
    tunnel_quic = { port = 7844, protocol = "udp", note = "Cloudflare tunnel, QUIC" }
    tunnel_h2   = { port = 7844, protocol = "tcp", note = "Cloudflare tunnel, HTTP/2 fallback" }
  }
}

resource "aws_vpc_security_group_egress_rule" "api_internet" {
  for_each          = local.api_egress_internet
  security_group_id = aws_security_group.api.id
  description       = each.value.note
  ip_protocol       = each.value.protocol
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "api_to_db" {
  security_group_id            = aws_security_group.api.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_egress_rule" "api_to_efs" {
  security_group_id            = aws_security_group.api.id
  description                  = "EFS (downloads and the IP database)"
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  referenced_security_group_id = aws_security_group.efs.id
}

# DNS goes to the VPC's own resolver, which security groups don't filter.

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL: from the API and job tasks only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from the tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }

  tags = { Name = "${local.name}-db" }
}

resource "aws_security_group" "efs" {
  name        = "${local.name}-efs"
  description = "EFS: from the API and job tasks only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS from the tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }

  tags = { Name = "${local.name}-efs" }
}
